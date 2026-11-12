// League money: what entry fees have come in, the league's payout account,
// payouts, withdrawals, fee reminders, and the provider's webhook.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LeagueFinance, Payment, PayoutAccount, Settlement } from '@/api/types';
import { COUNTRY_LIST, dueSettlements, summariseFinance, type FinanceCurrency, type SettlementSchedule } from '@/engine';
import type * as P from '~/generated/prisma/client';
import { json, prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { verifyPassword } from '~/lib/crypto';
import { ApiError, badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { oneAtATime } from '~/lib/lock';
import { entryShareFor } from '~/lib/shares';
import { payments, verifyFlutterwaveHash } from '~/lib/payments';
import { completeCheckout, requireFeature } from '~/services/billing';
import { clubAdminIds, isLeagueAdmin, notify, toCompetition, toEntry } from '~/lib/repo';

const HOLD_MS = 24 * 3600_000;

const toAccount = (a: P.PayoutAccount): PayoutAccount => ({
  orgId: a.orgId, kind: a.kind as PayoutAccount['kind'], institution: a.institution, institutionCode: a.institutionCode, last4: a.last4, accountName: a.accountName,
  schedule: a.schedule as SettlementSchedule, verifiedAt: a.verifiedAt.toISOString(), changedByName: a.changedByName, holdUntil: a.holdUntil?.toISOString(),
});
const toSettlement = (s: P.Settlement): Settlement => ({ ...s, currency: s.currency as Settlement['currency'], status: s.status as Settlement['status'], kind: s.kind as Settlement['kind'], createdAt: s.createdAt.toISOString(), paidAt: s.paidAt?.toISOString() });

async function orgOr404(id: string) {
  const o = await prisma.organisation.findUnique({ where: { id }, include: { payoutAccount: true } });
  if (!o) throw notFound('Organisation');
  return o;
}

const leagueAdminIds = async (orgId: string) => (await prisma.membership.findMany({ where: { orgId, role: { in: ['leagueAdmin', 'owner'] } }, select: { userId: true } })).map((m) => m.userId);

/** Every paid entry of an organisation's competitions, with the entry rows to update. */
async function paidEntries(orgId: string) {
  const comps = await prisma.competition.findMany({ where: { orgId } });
  const entries = await prisma.entry.findMany({ where: { competitionId: { in: comps.map((c) => c.id) } } });
  return { comps: comps.map(toCompetition), entries: entries.map(toEntry) };
}

/**
 * Development stand-in for the provider's settlement run: pays out whatever is
 * due. In production, settlements arrive from the provider and are recorded the same way.
 */
async function settleDue(orgId: string, currency: FinanceCurrency, account: P.PayoutAccount | null, now = new Date()) {
  if (!account || process.env.NODE_ENV === 'production') return;
  await prisma.settlement.updateMany({ where: { orgId, status: 'processing', createdAt: { lt: new Date(now.getTime() - 8000) } }, data: { status: 'paid', paidAt: now } });
  const { entries } = await paidEntries(orgId);
  const pays = entries.filter((e) => e.payment?.status === 'paid').map((e) => e.payment!);
  for (const g of dueSettlements(pays, currency, account.schedule as SettlementSchedule, now, account.holdUntil ?? undefined)) {
    const id = `stl_${orgId}_${g.on.getTime().toString(36)}`;
    await prisma.$transaction(async (tx) => {
      await tx.settlement.create({ data: { id, orgId, amount: g.amount, currency, paymentCount: g.paymentIds.length, status: 'paid', reference: `STL-${g.on.getTime().toString(36).toUpperCase().slice(-7)}`, accountLabel: `${account.institution} ending ${account.last4}`, kind: 'scheduled', createdAt: g.on, paidAt: g.on } });
      for (const e of entries) if (e.payment && g.paymentIds.includes(e.payment.id)) await tx.entry.update({ where: { id: e.id }, data: { payment: toJson({ ...e.payment, settlementId: id }) } });
    });
  }
}

export async function financeRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/organisations/:id/finance', async (req): Promise<LeagueFinance> => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only league admins can see the league’s money');
    const org = await orgOr404(req.params.id);
    const currency = org.currency as FinanceCurrency;
    await settleDue(org.id, currency, org.payoutAccount);
    const account = await prisma.payoutAccount.findUnique({ where: { orgId: org.id } });
    const { comps, entries } = await paidEntries(org.id);
    const summary = summariseFinance({ currency, competitions: comps, entries, schedule: account?.schedule as SettlementSchedule | undefined, holdUntil: account?.holdUntil ?? undefined });
    const settlements = await prisma.settlement.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'desc' } });
    return { orgId: org.id, currency, account: account ? toAccount(account) : undefined, ...summary, settlements: settlements.map(toSettlement) };
  });

  app.get('/payouts/institutions', async (req) => {
    const { country } = z.object({ country: z.string() }).parse(req.query);
    return payments().institutions(country);
  });

  app.post('/payouts/resolve', async (req) => {
    requireUser(req);
    const b = z.object({ country: z.string(), kind: z.enum(['bank', 'mobileMoney']), institutionCode: z.string(), accountNumber: z.string().transform((v) => v.replace(/\D/g, '')) }).parse(req.body);
    return payments().resolve(b);
  });

  app.put<{ Params: { id: string } }>('/organisations/:id/payout-account', async (req) => {
    const user = requireUser(req);
    const b = z.object({ kind: z.enum(['bank', 'mobileMoney']), institutionCode: z.string(), accountNumber: z.string().transform((v) => v.replace(/\D/g, '')).optional(), schedule: z.enum(['auto', 'weekly', 'manual']), password: z.string().min(1, 'Enter your password') }).parse(req.body);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only a league admin can change where the league is paid');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    if (!(await verifyPassword(row.passwordHash, b.password))) throw new ApiError(401, 'That password is not right');
    const org = await orgOr404(req.params.id);
    const previous = org.payoutAccount;
    await requireFeature(org.id, 'entryFeeCollection', 'Collecting entry fees online');
    const provider = payments();
    let data: Omit<P.PayoutAccount, 'orgId'>;
    if (!b.accountNumber) {
      // Only the schedule changes; the account stays as it is.
      if (!previous) throw badRequest('Add the account number');
      data = { ...previous, schedule: b.schedule, changedBy: user.id, changedByName: user.name };
    } else {
      const inst = (await provider.institutions(org.country)).find((i) => i.code === b.institutionCode);
      if (!inst) throw badRequest('Pick the bank or network');
      const { accountName } = await provider.resolve({ country: org.country, kind: b.kind, institutionCode: inst.code, accountNumber: b.accountNumber });
      const { subaccountId: subaccountCode } = await provider.createSubaccount({ businessName: org.name, country: org.country, institutionCode: inst.code, accountNumber: b.accountNumber, mobile: user.phone, email: user.email, share: await entryShareFor(org.id) });
      const same = !!previous && previous.institutionCode === inst.code && previous.last4 === b.accountNumber.slice(-4);
      data = {
        kind: inst.kind, institution: inst.name, institutionCode: inst.code, last4: b.accountNumber.slice(-4), accountName, provider: 'flutterwave', subaccountCode, schedule: b.schedule,
        verifiedAt: new Date(), changedBy: user.id, changedByName: user.name,
        // A new account holds payouts for a day, so a stolen login cannot quietly redirect money.
        holdUntil: previous && !same ? new Date(Date.now() + HOLD_MS) : previous?.holdUntil ?? null,
      };
    }
    const saved = await prisma.payoutAccount.upsert({ where: { orgId: org.id }, create: { orgId: org.id, ...data }, update: data });
    const moved = !!b.accountNumber && saved.holdUntil && saved.holdUntil > new Date();
    await notify(await leagueAdminIds(org.id), {
      kind: 'payment',
      title: previous ? (b.accountNumber ? 'League payout account changed' : 'League payout schedule changed') : 'League payout account added',
      body: `${saved.institution} ending ${saved.last4}, by ${user.name}.${moved ? ' Payouts pause for 24 hours. If this was not you, tell Ovalcast now.' : ''}`,
      link: { pathname: '/money/[orgId]', params: { orgId: org.id } },
    });
    return toAccount(saved);
  });

  app.post<{ Params: { id: string } }>('/organisations/:id/withdrawals', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only a league admin can withdraw');
    // One withdrawal per league at a time: a second one waits, then finds nothing left to send.
    return oneAtATime(`withdraw:${req.params.id}`, () => withdraw(req.params.id, user));
  });

  async function withdraw(orgId: string, user: { id: string; name: string }) {
    const org = await orgOr404(orgId);
    const account = org.payoutAccount;
    if (!account) throw conflict('Add a payout account first');
    if (account.schedule !== 'manual') throw conflict('This league is paid out automatically');
    if (account.holdUntil && account.holdUntil > new Date()) throw conflict('Payouts are paused for 24 hours after the account changed');
    const { comps, entries } = await paidEntries(org.id);
    const waiting = entries.filter((e) => e.payment?.status === 'paid' && e.payment.method !== 'cash' && !e.payment.settlementId);
    if (!waiting.length) throw conflict('Nothing to withdraw yet');
    const currency = org.currency as FinanceCurrency;
    const amount = summariseFinance({ currency, competitions: comps, entries, schedule: 'manual' }).totals.awaiting;
    const { reference } = await payments().transfer({ amount, currency, institutionCode: account.institutionCode, accountRef: account.subaccountCode, narration: `${org.shortName} entry fees`, reference: `WDL-${Date.now().toString(36).toUpperCase().slice(-7)}` });
    const id = newId('stl');
    const st = await prisma.$transaction(async (tx) => {
      const created = await tx.settlement.create({ data: { id, orgId: org.id, amount, currency, paymentCount: waiting.length, status: 'processing', reference, accountLabel: `${account.institution} ending ${account.last4}`, kind: 'withdrawal' } });
      for (const e of waiting) await tx.entry.update({ where: { id: e.id }, data: { payment: toJson({ ...e.payment, settlementId: id }) } });
      return created;
    });
    await notify(await leagueAdminIds(org.id), { kind: 'payment', title: `${user.name} withdrew league money`, body: `To ${st.accountLabel}. Reference ${st.reference}.`, link: { pathname: '/money/[orgId]', params: { orgId: org.id } } });
    return toSettlement(st);
  }

  app.post<{ Params: { id: string } }>('/entries/:id/remind', async (req, reply) => {
    const user = requireUser(req);
    const e = await prisma.entry.findUnique({ where: { id: req.params.id }, include: { competition: true } });
    if (!e) throw notFound('Entry');
    if (!isLeagueAdmin(user, e.competition.orgId)) throw forbidden('Only a league admin can send reminders');
    if (json<Payment | null>(e.payment)?.status === 'paid') throw conflict('This club has already paid');
    await notify(await clubAdminIds(e.teamId), { kind: 'payment', title: `Entry fee due for ${e.competition.name}`, body: 'Pay in the app by card, transfer, USSD or mobile money, or pay the league in cash.', link: { pathname: '/team/[id]', params: { id: e.teamId, tab: 'leagues' } } });
    return reply.status(204).send();
  });
}

/**
 * Flutterwave's webhook, outside /api/v1. The `verif-hash` header proves it
 * came from Flutterwave; the charge is then verified by id with Flutterwave
 * before the checkout is completed. Each event is applied once.
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/flutterwave', async (req, reply) => {
    if (!verifyFlutterwaveHash(req.headers['verif-hash'] as string | undefined)) return reply.status(401).send({ message: 'Bad signature' });
    const evt = z.object({ event: z.string(), data: z.object({ id: z.union([z.number(), z.string()]), tx_ref: z.string(), status: z.string(), amount: z.number(), currency: z.string() }).passthrough() }).parse(req.body);
    const eventId = `flutterwave:${evt.event}:${evt.data.id}`;
    try {
      await prisma.webhookEvent.create({ data: { id: eventId, provider: 'flutterwave', type: evt.event } });
    } catch {
      return reply.status(200).send({ ok: true, duplicate: true });
    }
    if (evt.event !== 'charge.completed' || evt.data.status !== 'successful') return reply.status(200).send({ ok: true });
    const checkout = await prisma.checkout.findUnique({ where: { id: evt.data.tx_ref } });
    if (!checkout) return reply.status(200).send({ ok: true, unknown: true });
    // Never trust the webhook body for money: ask Flutterwave.
    const charge = process.env.NODE_ENV === 'production' ? await payments().verify(String(evt.data.id)) : { id: String(evt.data.id), txRef: evt.data.tx_ref, status: evt.data.status, amount: evt.data.amount, currency: evt.data.currency, paymentType: String((evt.data as Record<string, unknown>).payment_type ?? 'card'), cardCountry: ((evt.data as Record<string, unknown>).card as { country?: string } | undefined)?.country, paidAt: new Date().toISOString() };
    if (charge.status !== 'successful' || charge.amount < checkout.amount || charge.currency !== checkout.currency || (charge.txRef && charge.txRef !== checkout.id)) {
      await prisma.checkout.update({ where: { id: checkout.id }, data: { status: 'failed' } });
      return reply.status(200).send({ ok: true, rejected: true });
    }
    // A card from outside the country whose currency this is pays the international fee.
    const home = COUNTRY_LIST.find((c) => c.currency === checkout.currency)?.code ?? '';
    await completeCheckout(checkout.id, { providerId: charge.id, paymentType: charge.paymentType, international: !!charge.cardCountry && !charge.cardCountry.toUpperCase().startsWith(home) });
    return reply.status(200).send({ ok: true });
  });
}
