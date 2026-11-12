// Scheduled work: Pro subscriptions that end, weekly host payouts, and
// accounts whose owners asked for deletion. Runs every hour; each job is safe to repeat.
//
//   npm run jobs   (once, by hand)

import type { FastifyBaseLogger } from 'fastify';

/** The API server's logger, or the worker's (scripts/worker.ts). */
type JobLog = Pick<FastifyBaseLogger, 'info' | 'error'>;
import { formatMoney, hostPayoutMinimum, type FinanceCurrency } from '@/engine';
import { refundIfMostlyDown, walletCurrency } from '~/services/billing';
import { prisma } from '~/db/client';
import { newId } from '~/lib/ids';
import { withLock } from '~/lib/lock';
import { payments } from '~/lib/payments';
import { notify } from '~/lib/repo';
import { forgetSetups } from './matches';

/** Pro ends at the period's end when cancelled; unpaid renewals get three days' grace, then end. */
export async function expireSubscriptions(now = new Date()) {
  const ended = await prisma.subscription.updateMany({ where: { status: { not: 'cancelled' }, renewsAt: { lt: now }, cancelAtPeriodEnd: true }, data: { status: 'cancelled' } });
  const late = await prisma.subscription.updateMany({ where: { status: 'active', renewsAt: { lt: now }, cancelAtPeriodEnd: false }, data: { status: 'pastDue' } });
  const grace = new Date(now.getTime() - 3 * 86_400_000);
  const lapsed = await prisma.subscription.findMany({ where: { status: 'pastDue', renewsAt: { lt: grace } } });
  for (const s of lapsed) {
    await prisma.subscription.update({ where: { id: s.id }, data: { status: 'cancelled' } });
    await notify(s.userId, { kind: 'payment', title: 'Pro has ended', body: 'The renewal did not go through. Your matches and stats are safe; upgrade again any time.', link: { pathname: '/plans' } });
  }
  return { ended: ended.count, pastDue: late.count, lapsed: lapsed.length };
}

/**
 * Mondays: every host with at least the local minimum waiting (₦5,000 or the same value)
 * is paid, in each currency they earned in. Smaller balances roll over.
 */
export async function payHosts(now = new Date()) {
  if (now.getUTCDay() !== 1) return { paid: 0, failed: 0 };
  const since = new Date(now.getTime() - 20 * 3600_000);
  const earned = await prisma.passSale.groupBy({ by: ['hostUserId', 'currency'], _sum: { host: true } });
  let paid = 0;
  let failed = 0;
  for (const h of earned) {
    const currency = (h.currency ?? (await walletCurrency(h.hostUserId))) as FinanceCurrency;
    // Already tried today in this currency: skip, so a repeated run never pays twice.
    if (await prisma.hostPayout.count({ where: { userId: h.hostUserId, currency, at: { gte: since } } })) continue;
    // What's been paid, or may have been (processing): a payout Flutterwave refused doesn't count.
    const out = await prisma.hostPayout.aggregate({ where: { userId: h.hostUserId, currency, status: { not: 'failed' } }, _sum: { amount: true } });
    const balance = (h._sum.host ?? 0) - (out._sum.amount ?? 0);
    if (balance < hostPayoutMinimum(currency)) continue;
    const reference = `HST-${newId('x').slice(-7).toUpperCase()}`;
    // Recorded before any money moves, so a crash after the transfer can never lead to paying again.
    const payout = await prisma.hostPayout.create({ data: { id: newId('hp'), userId: h.hostUserId, amount: balance, currency, status: 'processing', reference } });
    try {
      // The host's bank or wallet is held by Flutterwave against their account; development pays at once.
      const sent = await payments().transfer({ amount: balance, currency, institutionCode: '', accountRef: h.hostUserId, narration: 'Ovalcast stream earnings', reference });
      // Couldn't go automatically: it waits in the backoffice for staff to pay, and the host is told so.
      await prisma.hostPayout.update({ where: { id: payout.id }, data: { status: sent.manual ? 'pending' : 'paid' } });
      await notify(h.hostUserId, sent.manual
        ? { kind: 'payment', title: `${formatMoney(balance, currency)} stream earnings are being paid`, body: `Ovalcast pays them to your account within two working days. Reference ${reference}.` }
        : { kind: 'payment', title: `${formatMoney(balance, currency)} stream earnings paid`, body: `Reference ${reference}.` });
      paid += 1;
    } catch (e) {
      failed += 1;
      // Flutterwave said no (a 4xx): nothing was sent, so the balance is paid with next week's run.
      // No clear answer (a timeout, a 5xx): it may have gone, so it stays processing for staff to
      // check against Flutterwave's transfer list. Either way, one host never stops the others.
      const refused = (e as { status?: number }).status === 400;
      if (refused) await prisma.hostPayout.update({ where: { id: payout.id }, data: { status: 'failed' } });
      console.error(`[payouts] ${reference} for ${h.hostUserId}: ${refused ? 'refused' : 'no clear answer, left processing'}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { paid, failed };
}

/** Ended streams that were down for over 30% of the time: their passes are refunded, once. */
export async function refundDroppedStreams() {
  const ended = await prisma.stream.findMany({ where: { status: 'ended', refundedAt: null, downSeconds: { gt: 0 } }, select: { id: true } });
  let refunded = 0;
  for (const s of ended) if (await refundIfMostlyDown(s.id)) refunded += 1;
  return { refunded };
}

/** Accounts past their deletion date: personal data removed, match records kept without a name. */
export async function deleteAccounts(now = new Date()) {
  const due = await prisma.user.findMany({ where: { deleteOn: { lt: now } }, select: { id: true, playerId: true } });
  for (const u of due) {
    await prisma.$transaction([
      prisma.session.deleteMany({ where: { userId: u.id } }),
      prisma.membership.deleteMany({ where: { userId: u.id } }),
      prisma.notification.deleteMany({ where: { userId: u.id } }),
      prisma.certificate.deleteMany({ where: { userId: u.id } }),
      prisma.user.update({ where: { id: u.id }, data: { name: 'Deleted user', email: null, phone: null, city: null, officiating: undefined, follows: {}, passwordHash: '', deleteOn: null } }),
      ...(u.playerId ? [prisma.player.update({ where: { id: u.playerId }, data: { name: 'Former player', shortName: 'Former player' } })] : []),
    ]);
  }
  if (due.length) forgetSetups();
  return { deleted: due.length };
}

/** One machine at a time: two running together could both pay the same streamer. */
export async function runJobs(log?: JobLog) {
  const r = await withLock('ovalcast:jobs', async () => ({ subscriptions: await expireSubscriptions(), streams: await refundDroppedStreams(), hosts: await payHosts(), accounts: await deleteAccounts() }));
  if (r) log?.info(r, 'scheduled jobs');
  else log?.info('scheduled jobs: another machine is running them');
  return r;
}

export function startJobs(log: JobLog, everyMs = 3600_000) {
  const t = setInterval(() => void runJobs(log).catch((e) => log.error(e)), everyMs);
  t.unref();
  return () => clearInterval(t);
}
