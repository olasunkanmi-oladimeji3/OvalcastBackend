// Scheduled work: Pro subscriptions that end, weekly host payouts, and
// accounts whose owners asked for deletion. Runs every hour; each job is safe to repeat.
//
//   npm run jobs   (once, by hand)

import { sendMatchReminders } from './matchNews';
import type { FastifyBaseLogger } from 'fastify';

/** The API server's logger, or the worker's (scripts/worker.ts). */
type JobLog = Pick<FastifyBaseLogger, 'info' | 'error'>;
import { formatMoney, hostPayoutMinimum, type FinanceCurrency } from '@/engine';
import { refundIfMostlyDown, walletCurrency } from '~/services/billing';
import { prisma } from '~/db/client';
import { newId } from '~/lib/ids';
import { withLock } from '~/lib/lock';
import { payments } from '~/lib/payments';
import { notify, orgAdminIds } from '~/lib/repo';
import { forgetSetups, getMatch, saveMatch } from './matches';

/** Pro ends at the period's end when cancelled; unpaid renewals get three days' grace, then end. */
export async function expireSubscriptions(now = new Date()) {
  // Asked to stop: ends at the end of the period.
  const ending = await prisma.subscription.findMany({ where: { status: { not: 'cancelled' }, renewsAt: { lt: now }, cancelAtPeriodEnd: true } });
  for (const s of ending) {
    await prisma.subscription.update({ where: { id: s.id }, data: { status: 'cancelled' } });
    if (s.orgId) await organisationPlanEnded(s.orgId, 'The Organisation plan has ended', 'You chose not to renew. Your leagues, results and money records are safe; subscribe again any time.');
  }
  const late = await prisma.subscription.updateMany({ where: { status: 'active', renewsAt: { lt: now }, cancelAtPeriodEnd: false }, data: { status: 'pastDue' } });
  // Not renewed three days after the end: lapsed.
  const grace = new Date(now.getTime() - 3 * 86_400_000);
  const lapsed = await prisma.subscription.findMany({ where: { status: 'pastDue', renewsAt: { lt: grace } } });
  for (const s of lapsed) {
    await prisma.subscription.update({ where: { id: s.id }, data: { status: 'cancelled' } });
    if (s.orgId) await organisationPlanEnded(s.orgId, 'The Organisation plan has lapsed', 'The renewal wasn’t paid. Your leagues and results are safe, but the API, online entry fees and plan limits are back to Free. Subscribe again to switch them back on.');
    else await notify(s.userId, { kind: 'payment', title: 'Pro has ended', body: 'The renewal did not go through. Your matches and stats are safe; upgrade again any time.', link: { pathname: '/plans' } });
  }
  // Five days before a renewal: a reminder to pay (renewals aren't charged automatically), once per period.
  const soon = await prisma.subscription.findMany({ where: { status: 'active', cancelAtPeriodEnd: false, renewsAt: { gt: now, lt: new Date(now.getTime() + 5 * 86_400_000) } } });
  let reminded = 0;
  for (const s of soon) {
    if (s.remindedFor && s.remindedFor.getTime() === s.renewsAt.getTime()) continue;
    await prisma.subscription.update({ where: { id: s.id }, data: { remindedFor: s.renewsAt } });
    const day = s.renewsAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    if (s.orgId) {
      const org = await prisma.organisation.findUnique({ where: { id: s.orgId }, select: { name: true } });
      await notify(await orgAdminIds(s.orgId), { kind: 'payment', title: `${org?.name ?? 'Your organisation'}: Organisation plan renews ${day}`, body: 'Renew from the organisation’s page to keep the API, online entry fees and unlimited leagues.', link: { pathname: '/organisation/[id]', params: { id: s.orgId } } });
    } else await notify(s.userId, { kind: 'payment', title: `Pro renews ${day}`, body: 'Renew from Plans to keep Pro.', link: { pathname: '/plans' } });
    reminded++;
  }
  return { ended: ending.length, pastDue: late.count, lapsed: lapsed.length, reminded };
}


/** An organisation's subscription ended: back to Free, unless Ovalcast put it on the plan by contract or another subscription still covers it. */
async function organisationPlanEnded(orgId: string, title: string, body: string) {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { planContract: true } });
  const still = await prisma.subscription.count({ where: { orgId, status: { in: ['active', 'pastDue'] } } });
  if (!org || org.planContract || still) return;
  await prisma.organisation.update({ where: { id: orgId }, data: { plan: 'free' } });
  await notify(await orgAdminIds(orgId), { kind: 'payment', title, body, link: { pathname: '/organisation/[id]', params: { id: orgId } } });
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

/**
 * Matches left running: started, then nobody scored for 24 hours (a test, or a scorer who stopped
 * halfway). A friendly is closed as no result. A league match affects the table, so its organiser
 * is told first, and it's closed as no result after 7 days if nobody finishes or changes it.
 */
export async function endStaleMatches(now = new Date()) {
  const DAY = 86_400_000;
  const running = await prisma.match.findMany({ where: { status: { in: ['toss', 'live', 'inningsBreak'] } }, select: { id: true, competitionId: true, startedAt: true, startsAt: true, remindersSent: true, homeTeamId: true, awayTeamId: true, createdBy: true, scorerUserId: true } });
  let closed = 0;
  let warned = 0;
  for (const m of running) {
    const last = await prisma.ballEvent.findFirst({ where: { matchId: m.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const quietSince = last?.createdAt ?? m.startedAt ?? m.startsAt;
    const quiet = now.getTime() - quietSince.getTime();
    if (quiet < DAY) continue;
    const teams = new Map((await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const vs = `${teams.get(m.homeTeamId) ?? 'Home'} v ${teams.get(m.awayTeamId) ?? 'Away'}`;
    const link = { pathname: '/match/[id]', params: { id: m.id } };
    let organisers = [m.createdBy, m.scorerUserId].filter((u): u is string => !!u);
    if (m.competitionId) {
      const c = await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } });
      if (c) organisers = [...organisers, ...(await orgAdminIds(c.orgId))];
      if (quiet < 7 * DAY) {
        if (m.remindersSent.includes('stale')) continue;
        await prisma.match.update({ where: { id: m.id }, data: { remindersSent: { push: 'stale' } } });
        await notify([...new Set(organisers)], { kind: 'match', title: `${vs} has stopped`, body: 'No ball for a day. Finish scoring, or record a stoppage. If nothing changes in 7 days it’s closed as no result.', link });
        warned++;
        continue;
      }
    }
    const match = await getMatch(m.id);
    match.status = 'abandoned';
    match.result = { outcome: 'noResult', text: 'No result' };
    match.outcomeNote = `Scoring stopped and the match wasn’t finished, so Ovalcast closed it after ${m.competitionId ? '7 days' : 'a day'} without a ball.`;
    await saveMatch(match);
    await prisma.stream.updateMany({ where: { matchId: m.id, status: 'live' }, data: { status: 'ended' } });
    await notify([...new Set(organisers)], { kind: 'match', title: `${vs} closed as no result`, body: 'Nobody scored for a day, so Ovalcast closed it. The balls scored are kept on the scorecard.', link });
    closed++;
  }
  return { closed, warned };
}

/** One machine at a time: two running together could both pay the same streamer. */
export async function runJobs(log?: JobLog) {
  const r = await withLock('ovalcast:jobs', async () => ({ subscriptions: await expireSubscriptions(), streams: await refundDroppedStreams(), accounts: await deleteAccounts(), stale: await endStaleMatches() }));
  if (r) log?.info(r, 'scheduled jobs');
  else log?.info('scheduled jobs: another machine is running them');
  return r;
}

export function startJobs(log: JobLog, everyMs = 3600_000) {
  const t = setInterval(() => void runJobs(log).catch((e) => log.error(e)), everyMs);
  t.unref();
  // Match reminders need finer timing (two hours before), so they run every five minutes.
  const r = setInterval(() => void withLock('ovalcast:reminders', () => sendMatchReminders()).catch((e) => log.error(e)), 5 * 60_000);
  r.unref();
  return () => (clearInterval(t), clearInterval(r));
}
