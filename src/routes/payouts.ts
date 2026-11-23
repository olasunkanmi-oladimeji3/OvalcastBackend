// Getting paid. Streamers and hosts add their own bank or mobile money account (with their password;
// Flutterwave confirms the name; payouts pause for 24 hours after a change) and withdraw their balance
// whenever it's over the minimum: their own money, so no approval. A transfer stays "processing" until
// Flutterwave confirms it; a failed one goes back into the balance. Every withdrawal and account change
// is logged with the device and network. Staff see transfers that need attention and can mark one paid.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FinanceCurrency } from '@/engine';
import { formatMoney, hostPayoutMinimum } from '@/engine';
import { prisma, toJson } from '~/db/client';
import { requireStaff, requireUser } from '~/lib/auth';
import { verifyPassword } from '~/lib/crypto';
import { ApiError, badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { oneAtATime } from '~/lib/lock';
import { logMoney } from '~/lib/moneyLog';
import { payInstantly, payments } from '~/lib/payments';
import { notify, orgAdminIds } from '~/lib/repo';
import { open as openSecret, seal } from '~/lib/secrets';
import { logStaff } from '~/lib/staffLog';
import { walletCurrency } from '~/services/billing';

const HOLD_MS = 24 * 3600_000;

/** What a host is owed in each currency: their part of passes and donations, less payouts not refused. */
export async function hostBalances(userId: string) {
  // A match still streaming on Ovalcast isn't settled (the small-stream rule may change its split at the
  // end), so its takings can't be withdrawn until the stream ends.
  const live = (await prisma.stream.findMany({ where: { status: { not: 'ended' }, platform: 'ovalcast' }, select: { matchId: true } })).map((s) => s.matchId);
  const [sales, payouts] = await Promise.all([
    prisma.passSale.groupBy({ by: ['currency'], where: { hostUserId: userId, ...(live.length ? { matchId: { notIn: live } } : {}) }, _sum: { host: true } }),
    prisma.hostPayout.groupBy({ by: ['currency'], where: { userId, status: { not: 'failed' } }, _sum: { amount: true } }),
  ]);
  const fallback = await walletCurrency(userId);
  const out = new Map<string, number>();
  for (const s of sales) out.set(s.currency ?? fallback, (out.get(s.currency ?? fallback) ?? 0) + (s._sum.host ?? 0));
  for (const p of payouts) out.set(p.currency ?? fallback, (out.get(p.currency ?? fallback) ?? 0) - (p._sum.amount ?? 0));
  return out;
}

const accountView = (a: { kind: string; institution: string; last4: string; accountName: string; holdUntil: Date | null; verifiedAt: Date }) => ({
  kind: a.kind as 'bank' | 'mobileMoney',
  institution: a.institution,
  last4: a.last4,
  accountName: a.accountName,
  verifiedAt: a.verifiedAt.toISOString(),
  ...(a.holdUntil && a.holdUntil > new Date() ? { holdUntil: a.holdUntil.toISOString() } : {}),
});

/** Applies Flutterwave's word on a transfer: paid, or failed (the money returns to whoever it was for). */
export async function settleTransfer(reference: string, status: 'successful' | 'failed') {
  const host = await prisma.hostPayout.findFirst({ where: { reference } });
  if (host) {
    if (host.status === 'paid' || host.status === 'failed') return 'unchanged';
    await prisma.hostPayout.update({ where: { id: host.id }, data: status === 'successful' ? { status: 'paid', paidAt: new Date() } : { status: 'failed' } });
    const money = formatMoney(host.amount, (host.currency ?? 'NGN') as FinanceCurrency);
    await notify(host.userId, status === 'successful'
      ? { kind: 'payment', title: `${money} withdrawn`, body: `It’s in ${host.accountLabel ?? 'your account'}. Reference ${host.reference}.`, link: { pathname: '/earnings' } }
      : { kind: 'payment', title: `${money} withdrawal didn’t go through`, body: `The bank turned it down, so it’s back in your balance. Check your account details and try again. Reference ${host.reference}.`, link: { pathname: '/earnings' } });
    return 'host';
  }
  const st = await prisma.settlement.findFirst({ where: { reference } });
  if (st) {
    if (st.status === 'paid' || st.status === 'failed') return 'unchanged';
    await prisma.settlement.update({ where: { id: st.id }, data: status === 'successful' ? { status: 'paid', paidAt: new Date() } : { status: 'failed' } });
    if (status === 'failed') {
      // The entry fees it carried are waiting again, ready for the next withdrawal.
      const entries = await prisma.entry.findMany({ where: { competition: { orgId: st.orgId } }, select: { id: true, payment: true } });
      for (const e of entries) {
        const pay = e.payment as { settlementId?: string } | null;
        if (pay?.settlementId === st.id) await prisma.entry.update({ where: { id: e.id }, data: { payment: toJson({ ...pay, settlementId: undefined }) } });
      }
    }
    const money = formatMoney(st.amount, st.currency as FinanceCurrency);
    await notify(await orgAdminIds(st.orgId), status === 'successful'
      ? { kind: 'payment', title: `${money} league withdrawal paid`, body: `To ${st.accountLabel}. Reference ${st.reference}.`, link: { pathname: '/money/[orgId]', params: { orgId: st.orgId } } }
      : { kind: 'payment', title: `${money} league withdrawal didn’t go through`, body: `The bank turned it down; the money is waiting to withdraw again. Reference ${st.reference}.`, link: { pathname: '/money/[orgId]', params: { orgId: st.orgId } } });
    return 'league';
  }
  return 'unknown';
}

/**
 * Asks Flutterwave about every withdrawal still on its way, so they're confirmed even when its
 * webhook never arrives. Runs every five minutes; a transfer is given two minutes first, and after
 * a week it's left to staff (it shows on their list after two days).
 */
export async function confirmTransfers(now = new Date()) {
  const window = { gte: new Date(now.getTime() - 7 * 86_400_000), lte: new Date(now.getTime() - 2 * 60_000) };
  const [hosts, leagues] = await Promise.all([
    prisma.hostPayout.findMany({ where: { status: 'processing', providerId: { not: null }, at: window }, select: { reference: true, providerId: true }, take: 50 }),
    prisma.settlement.findMany({ where: { status: 'processing', providerId: { not: null }, createdAt: window }, select: { reference: true, providerId: true }, take: 50 }),
  ]);
  const out = { checked: 0, paid: 0, failed: 0 };
  for (const t of [...hosts, ...leagues]) {
    out.checked++;
    try {
      const s = await payments().transferStatus(t.providerId!);
      if (s.status === 'pending' || s.reference !== t.reference) continue;
      if ((await settleTransfer(t.reference, s.status)) !== 'unchanged') out[s.status === 'successful' ? 'paid' : 'failed']++;
    } catch {
      // Flutterwave didn't answer: try again next time.
    }
  }
  return out;
}

export async function payoutRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ your account
  app.get('/me/payout-account', async (req) => {
    const user = requireUser(req);
    const a = await prisma.userPayoutAccount.findUnique({ where: { userId: user.id } });
    return a ? accountView(a) : null;
  });

  app.put('/me/payout-account', async (req) => {
    const user = requireUser(req);
    const b = z.object({ institutionCode: z.string().trim().min(1).max(20), accountNumber: z.string().transform((v) => v.replace(/\D/g, '')).pipe(z.string().min(6, 'Check the account number').max(20)), password: z.string().min(1, 'Enter your password').max(200) }).parse(req.body);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true, country: true } });
    if (!(await verifyPassword(row.passwordHash, b.password))) throw new ApiError(403, 'That password is not right');
    const country = row.country ?? 'Nigeria';
    const provider = payments();
    const inst = (await provider.institutions(country)).find((i) => i.code === b.institutionCode);
    if (!inst) throw badRequest('Pick the bank or network');
    const { accountName } = await provider.resolve({ country, kind: inst.kind, institutionCode: inst.code, accountNumber: b.accountNumber });
    const previous = await prisma.userPayoutAccount.findUnique({ where: { userId: user.id } });
    const same = !!previous && previous.institutionCode === inst.code && openSecret(previous.accountNumberEnc) === b.accountNumber;
    // A new account pauses withdrawals for a day, so a stolen login can't quietly send the money elsewhere.
    const holdUntil = previous && !same ? new Date(Date.now() + HOLD_MS) : previous?.holdUntil ?? null;
    const data = { kind: inst.kind, country, institution: inst.name, institutionCode: inst.code, last4: b.accountNumber.slice(-4), accountName, accountNumberEnc: seal(b.accountNumber), verifiedAt: new Date(), holdUntil };
    const saved = await prisma.userPayoutAccount.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
    await logMoney(req, { userId: user.id, action: 'payoutAccount', detail: `${saved.institution} ending ${saved.last4}` });
    await notify(user.id, { kind: 'payment', title: previous ? 'Your payout account changed' : 'Payout account added', body: `${saved.institution} ending ${saved.last4}, ${saved.accountName}.${previous && !same ? ' Withdrawals pause for 24 hours. If this wasn’t you, change your password and tell Ovalcast now.' : ''}`, link: { pathname: '/earnings' } });
    return accountView(saved);
  });

  // Withdraw: the whole balance in one currency, to your account. Your own money, so no one approves
  // it, but your password does, so a stolen session cannot empty it.
  app.post('/me/withdrawals', async (req) => {
    const user = requireUser(req);
    const { currency: wanted, password } = z.object({ currency: z.string().length(3).optional(), password: z.string().min(1, 'Enter your password').max(200) }).parse(req.body ?? {});
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    if (!(await verifyPassword(row.passwordHash, password))) throw new ApiError(403, 'That password is not right');
    return oneAtATime(`host-withdraw:${user.id}`, async () => {
      const account = await prisma.userPayoutAccount.findUnique({ where: { userId: user.id } });
      if (!account) throw conflict('Add the account to be paid into first');
      if (account.holdUntil && account.holdUntil > new Date()) throw conflict(`Withdrawals are paused until ${account.holdUntil.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}, 24 hours after the account changed`);
      if (await prisma.hostPayout.count({ where: { userId: user.id, status: 'processing' } })) throw conflict('A withdrawal is still on its way. Try again once it’s confirmed');
      const balances = await hostBalances(user.id);
      const currency = (wanted ?? [...balances].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (await walletCurrency(user.id))) as FinanceCurrency;
      const amount = balances.get(currency) ?? 0;
      if (amount < hostPayoutMinimum(currency)) throw conflict(`You can withdraw from ${formatMoney(hostPayoutMinimum(currency), currency)}. Your balance is ${formatMoney(Math.max(0, amount), currency)}`);
      const reference = `HST-${newId('x').slice(-8).toUpperCase()}`;
      const accountLabel = `${account.institution} ending ${account.last4}`;
      // Recorded before any money moves, so a crash after the transfer can never send it twice.
      const payout = await prisma.hostPayout.create({ data: { id: newId('hp'), userId: user.id, amount, currency, status: 'processing', reference, accountLabel } });
      await logMoney(req, { userId: user.id, action: 'withdrawal', amount, currency, reference, detail: accountLabel });
      try {
        const sent = await payments().transfer({ amount, currency, institutionCode: account.institutionCode, accountRef: user.id, accountNumber: openSecret(account.accountNumberEnc), narration: 'Ovalcast stream earnings', reference });
        if (sent.id) await prisma.hostPayout.update({ where: { id: payout.id }, data: { providerId: sent.id } });
      } catch (e) {
        // Flutterwave said no (a 4xx): nothing went, so the money stays in the balance.
        if ((e as { status?: number }).status === 400) {
          await prisma.hostPayout.update({ where: { id: payout.id }, data: { status: 'failed' } });
          throw conflict(`The bank turned it down: ${e instanceof Error ? e.message : 'check the account'}. Nothing was taken from your balance`);
        }
        // No clear answer: it may have gone, so it stays processing for Flutterwave's confirmation (or staff).
        req.log.error(e, `withdrawal ${reference}: no clear answer`);
      }
      // Development has no Flutterwave to confirm it: paid at once.
      if (payInstantly()) await settleTransfer(reference, 'successful');
      const saved = await prisma.hostPayout.findUniqueOrThrow({ where: { id: payout.id } });
      return { id: saved.id, amount: saved.amount, currency: saved.currency, status: saved.status, reference: saved.reference, accountLabel, at: saved.at.toISOString() };
    });
  });

  // ------------------------------------------------------------ staff
  // Transfers that need a look: refused, not confirmed after two days, or left for staff to pay.
  app.get('/staff/payouts/attention', async (req) => {
    requireStaff(req);
    const twoDays = new Date(Date.now() - 2 * 86_400_000);
    const month = new Date(Date.now() - 30 * 86_400_000);
    const [hosts, leagues] = await Promise.all([
      prisma.hostPayout.findMany({ where: { OR: [{ status: 'pending' }, { status: 'processing', at: { lt: twoDays } }, { status: 'failed', at: { gte: month } }] }, orderBy: { at: 'desc' }, take: 200 }),
      prisma.settlement.findMany({ where: { kind: 'withdrawal', OR: [{ status: 'processing', createdAt: { lt: twoDays } }, { status: 'failed', createdAt: { gte: month } }] }, orderBy: { createdAt: 'desc' }, take: 200, include: { org: { select: { name: true } } } }),
    ]);
    const names = new Map((await prisma.user.findMany({ where: { id: { in: hosts.map((h) => h.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return [
      ...hosts.map((h) => ({ kind: 'host' as const, id: h.id, who: names.get(h.userId) ?? 'A host', whoId: h.userId, amount: h.amount, currency: h.currency ?? 'NGN', status: h.status, reference: h.reference, account: h.accountLabel ?? undefined, at: h.at.toISOString() })),
      ...leagues.map((s) => ({ kind: 'league' as const, id: s.id, who: s.org.name, whoId: s.orgId, amount: s.amount, currency: s.currency, status: s.status, reference: s.reference, account: s.accountLabel, at: s.createdAt.toISOString() })),
    ].sort((a, b) => b.at.localeCompare(a.at));
  });

  // Paid outside Ovalcast (from Flutterwave's dashboard, say): recorded with the bank's reference.
  app.post<{ Params: { kind: string; id: string } }>('/staff/payouts/:kind/:id/mark-paid', async (req) => {
    const staff = requireStaff(req);
    const { note } = z.object({ note: z.string().trim().min(3, 'Give the bank or Flutterwave reference').max(200) }).parse(req.body);
    if (req.params.kind === 'host') {
      const h = await prisma.hostPayout.findUnique({ where: { id: req.params.id } });
      if (!h) throw notFound('Payout');
      if (h.status === 'paid') throw conflict('Already paid');
      // A refused transfer's money went back to their balance; paying it by hand would pay it twice.
      if (h.status === 'failed') throw conflict('This one was turned down and the money went back to their balance. They can withdraw it again');
      await prisma.hostPayout.update({ where: { id: h.id }, data: { status: 'paid', paidAt: new Date(), note } });
      await notify(h.userId, { kind: 'payment', title: `${formatMoney(h.amount, (h.currency ?? 'NGN') as FinanceCurrency)} withdrawn`, body: `Paid to ${h.accountLabel ?? 'your account'}. Reference ${note}.`, link: { pathname: '/earnings' } });
      await logMoney(req, { userId: staff.id, action: 'markedPaid', amount: h.amount, currency: h.currency ?? undefined, reference: h.reference, detail: `host ${h.userId}: ${note}` });
    } else if (req.params.kind === 'league') {
      const s = await prisma.settlement.findUnique({ where: { id: req.params.id } });
      if (!s) throw notFound('Withdrawal');
      if (s.status === 'paid') throw conflict('Already paid');
      if (s.status === 'failed') throw conflict('This one was turned down and the money is waiting for the league to withdraw again');
      await prisma.settlement.update({ where: { id: s.id }, data: { status: 'paid', paidAt: new Date() } });
      await notify(await orgAdminIds(s.orgId), { kind: 'payment', title: `${formatMoney(s.amount, s.currency as FinanceCurrency)} league withdrawal paid`, body: `To ${s.accountLabel}. Reference ${note}.`, link: { pathname: '/money/[orgId]', params: { orgId: s.orgId } } });
      await logMoney(req, { userId: staff.id, orgId: s.orgId, action: 'markedPaid', amount: s.amount, currency: s.currency, reference: s.reference, detail: note });
    } else throw forbidden('Unknown payout');
    await logStaff(staff, 'markPayoutPaid', req.params.kind, req.params.id, note);
    return { ok: true as const };
  });
}
