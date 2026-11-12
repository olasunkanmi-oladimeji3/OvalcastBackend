// The backoffice: Ovalcast staff check accounts, follow what's happening across the platform,
// and see the money, above all what streaming brings in. Staff only; every action is logged.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActivityItem, ActivityKind, StaffActionRow, StaffOverview, StaffShares, StaffUserDetail, StaffUserRow, StreamingMoney, StreamingTotals } from '@/api/types';
import { currencyForCountry } from '@/engine';
import type * as P from '~/generated/prisma/client';
import { prisma } from '~/db/client';
import { requireStaff } from '~/lib/auth';
import { emit } from '~/lib/bus';
import { badRequest, notFound } from '~/lib/errors';
import { matchIdsWithOfficial } from '~/lib/repo';
import { logStaff } from '~/lib/staffLog';
import { globalShares, setGlobalShares, setOrganisationShares, setStreamerShare } from '~/lib/shares';

const DAY = 86_400_000;
const PLAYED = ['live', 'inningsBreak', 'completed'];
const since = (days: number) => new Date(Date.now() - days * DAY);
const iso = (d?: Date | null) => d?.toISOString() ?? undefined;
const daysParam = z.coerce.number().int().min(1).max(366).default(30);

const ROLE: Record<string, string> = { owner: 'Owner', leagueAdmin: 'League admin', clubAdmin: 'Club admin', scorer: 'Scorer', player: 'Player' };

type UserWithRoles = P.User & { memberships: P.Membership[] };

function row(u: UserWithRoles): StaffUserRow {
  const officiating = (u.officiating as { roles?: string[] } | null)?.roles ?? [];
  const roles = [...new Set([...u.memberships.map((m) => ROLE[m.role] ?? m.role), ...officiating.map((r) => r[0].toUpperCase() + r.slice(1))])];
  return {
    id: u.id,
    name: u.name,
    email: u.email ?? undefined,
    phone: u.phone ?? undefined,
    verified: u.emailVerified || u.phoneVerified,
    city: u.city ?? undefined,
    country: u.country ?? undefined,
    createdAt: u.createdAt.toISOString(),
    lastSeenAt: iso(u.lastSeenAt),
    staff: u.staff,
    suspended: !!u.suspendedAt,
    lockedUntil: u.lockedUntil && u.lockedUntil.getTime() > Date.now() ? u.lockedUntil.toISOString() : undefined,
    roles,
  };
}

// ------------------------------------------------------------------ money helpers

/** "Yaba Royals v Lekki Waves" for each match id. */
async function matchLabels(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const ms = await prisma.match.findMany({ where: { id: { in: unique } }, select: { id: true, homeTeamId: true, awayTeamId: true, startsAt: true } });
  const teams = await prisma.team.findMany({ where: { id: { in: ms.flatMap((m) => [m.homeTeamId, m.awayTeamId]) } }, select: { id: true, name: true } });
  const name = new Map(teams.map((t) => [t.id, t.name]));
  return new Map(ms.map((m) => [m.id, { label: `${name.get(m.homeTeamId) ?? 'TBD'} v ${name.get(m.awayTeamId) ?? 'TBD'}`, date: m.startsAt }]));
}

type Sums = { _count: { _all: number }; _sum: { price: number | null; fee: number | null; hostShare: number | null } };

/** Adds one group of passes into totals: refunded passes count as sold, then given back. */
function addPasses<T extends { passes: number; gross: number; refunded: number; fees: number; ovalcast: number }>(t: T, status: string, g: Sums, host: (n: number) => void) {
  const price = g._sum.price ?? 0;
  t.passes += g._count._all;
  t.gross += price;
  if (status === 'refunded') t.refunded += price;
  else {
    const fee = g._sum.fee ?? 0;
    const share = g._sum.hostShare ?? 0;
    t.fees += fee;
    host(share);
    t.ovalcast += price - fee - share;
  }
}

/** Pass money per currency, added up by the database. Each pass stores how its price was split. */
async function passTotals(where: P.Prisma.MatchPassWhereInput): Promise<StreamingTotals[]> {
  const groups = await prisma.matchPass.groupBy({ by: ['currency', 'status'], where, _count: { _all: true }, _sum: { price: true, fee: true, hostShare: true } });
  const by = new Map<string, StreamingTotals>();
  for (const g of groups) {
    const t = by.get(g.currency) ?? { currency: g.currency, passes: 0, gross: 0, refunded: 0, fees: 0, hosts: 0, ovalcast: 0 };
    addPasses(t, g.status, g, (n) => (t.hosts += n));
    by.set(g.currency, t);
  }
  return [...by.values()].sort((a, b) => b.gross - a.gross);
}

/** An organisation's currency, for money rows that don't carry one. */
async function orgCurrencies(ids: string[]) {
  const orgs = await prisma.organisation.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, currency: true } });
  return new Map(orgs.map((o) => [o.id, o]));
}

// ------------------------------------------------------------------ activity

const ACTIVITY_KINDS = ['signup', 'signin', 'pass', 'payment', 'paymentFailed', 'refund', 'payout', 'matchStarted', 'story', 'entry', 'staff'] as const;
const PAYMENT_NAME: Record<string, string> = { entry: 'an entry fee', pro: 'Ovalcast Pro', topUp: 'a wallet top-up', credits: 'viewer hours', pass: 'a match pass' };

/** Everything that happened, newest first, built from the records each part of Ovalcast keeps. */
async function activity(p: { kind?: ActivityKind; userId?: string; before?: Date; take?: number }): Promise<ActivityItem[]> {
  const take = p.take ?? 50;
  const before = p.before ?? new Date(Date.now() + 1000);
  const want = (k: ActivityKind) => !p.kind || p.kind === k;
  const who = p.userId;
  const jobs: Promise<ActivityItem[]>[] = [];

  if (want('signup'))
    jobs.push(
      prisma.user
        .findMany({ where: { createdAt: { lt: before }, ...(who ? { id: who } : {}) }, orderBy: { createdAt: 'desc' }, take, select: { id: true, name: true, createdAt: true, city: true, country: true } })
        .then((rows) => rows.map((u) => ({ id: `signup:${u.id}`, at: u.createdAt.toISOString(), kind: 'signup' as const, text: `${u.name} created an account${u.city ? ` in ${u.city}` : ''}`, userId: u.id, userName: u.name }))),
    );
  if (want('signin'))
    jobs.push(
      prisma.session
        .findMany({ where: { createdAt: { lt: before }, ...(who ? { userId: who } : {}) }, orderBy: { createdAt: 'desc' }, take, include: { user: { select: { name: true } } } })
        .then((rows) => rows.map((s) => ({ id: `signin:${s.tokenHash.slice(0, 16)}`, at: s.createdAt.toISOString(), kind: 'signin' as const, text: `${s.user.name} signed in`, userId: s.userId, userName: s.user.name }))),
    );
  if (want('pass'))
    jobs.push(
      prisma.matchPass.findMany({ where: { at: { lt: before }, ...(who ? { userId: who } : {}) }, orderBy: { at: 'desc' }, take, include: { user: { select: { name: true } } } }).then(async (rows) => {
        const labels = await matchLabels(rows.map((r) => r.matchId));
        return rows.map((x) => ({
          id: `pass:${x.id}`,
          at: x.at.toISOString(),
          kind: 'pass' as const,
          text: `${x.user.name} bought ${x.matchId ? `a pass for ${labels.get(x.matchId)?.label ?? 'a match'}` : 'a season pass'}${x.status === 'refunded' ? ' (refunded since)' : ''}`,
          userId: x.userId,
          userName: x.user.name,
          amount: x.price,
          currency: x.currency,
          href: x.matchId ? `/matches/${x.matchId}` : undefined,
        }));
      }),
    );
  if (want('payment') || want('paymentFailed'))
    jobs.push(
      prisma.checkout
        .findMany({
          where: { createdAt: { lt: before }, kind: { not: 'pass' }, status: p.kind === 'payment' ? 'paid' : p.kind === 'paymentFailed' ? 'failed' : { in: ['paid', 'failed'] }, ...(who ? { userId: who } : {}) },
          orderBy: { createdAt: 'desc' },
          take,
        })
        .then(async (rows) => {
          const users = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
          return rows.map((c) => ({
            id: `checkout:${c.id}`,
            at: (c.paidAt ?? c.createdAt).toISOString(),
            kind: c.status === 'paid' ? ('payment' as const) : ('paymentFailed' as const),
            text: `${users.get(c.userId) ?? 'Someone'} ${c.status === 'paid' ? 'paid for' : 'failed to pay for'} ${PAYMENT_NAME[c.kind] ?? c.kind} by ${c.method}`,
            userId: c.userId,
            userName: users.get(c.userId),
            amount: c.amount,
            currency: c.currency,
          }));
        }),
    );
  if (want('refund'))
    jobs.push(
      prisma.walletEntry
        .findMany({ where: { kind: 'refund', at: { lt: before }, ...(who ? { userId: who } : {}) }, orderBy: { at: 'desc' }, take, include: { wallet: { select: { currency: true, user: { select: { name: true } } } } } })
        .then((rows) => rows.map((w) => ({ id: `refund:${w.id}`, at: w.at.toISOString(), kind: 'refund' as const, text: `${w.wallet.user.name} was refunded: ${w.note}`, userId: w.userId, userName: w.wallet.user.name, amount: w.amount, currency: w.wallet.currency ?? undefined }))),
    );
  if (want('payout'))
    jobs.push(
      prisma.hostPayout.findMany({ where: { at: { lt: before }, ...(who ? { userId: who } : {}) }, orderBy: { at: 'desc' }, take }).then(async (rows) => {
        const users = new Map((await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
        return rows.map((h) => ({ id: `payout:${h.id}`, at: h.at.toISOString(), kind: 'payout' as const, text: `Stream earnings ${h.status === 'paid' ? 'paid out' : h.status} to ${users.get(h.userId) ?? 'a host'}, ${h.reference}`, userId: h.userId, userName: users.get(h.userId), amount: h.amount, currency: h.currency ?? undefined }));
      }),
    );
  if (want('matchStarted'))
    jobs.push(
      prisma.match.findMany({ where: { startedAt: { lt: before, not: null }, ...(who ? { OR: [{ createdBy: who }, { scorerUserId: who }] } : {}) }, orderBy: { startedAt: 'desc' }, take, select: { id: true, startedAt: true, venue: true } }).then(async (rows) => {
        const labels = await matchLabels(rows.map((r) => r.id));
        return rows.map((m) => ({ id: `match:${m.id}`, at: m.startedAt!.toISOString(), kind: 'matchStarted' as const, text: `${labels.get(m.id)?.label ?? 'A match'} started at ${m.venue}`, href: `/matches/${m.id}` }));
      }),
    );
  if (want('story'))
    jobs.push(
      prisma.story
        .findMany({ where: { createdAt: { lt: before }, ...(who ? { authorId: who } : {}) }, orderBy: { createdAt: 'desc' }, take })
        .then((rows) => rows.map((s) => ({ id: `story:${s.id}`, at: s.createdAt.toISOString(), kind: 'story' as const, text: `${s.authorName} posted: “${s.text.slice(0, 90)}${s.text.length > 90 ? '…' : ''}”`, userId: s.authorId, userName: s.authorName, href: '/stories' }))),
    );
  if (want('entry') && !who)
    jobs.push(
      prisma.entry
        .findMany({ where: { createdAt: { lt: before } }, orderBy: { createdAt: 'desc' }, take, include: { team: { select: { name: true } }, competition: { select: { name: true, id: true } } } })
        .then((rows) => rows.map((e) => ({ id: `entry:${e.id}`, at: e.createdAt.toISOString(), kind: 'entry' as const, text: `${e.team.name} ${e.kind === 'invite' ? 'was invited to' : 'asked to join'} ${e.competition.name}, ${e.status}`, href: `/leagues/${e.competition.id}` }))),
    );
  if (want('staff'))
    jobs.push(
      prisma.staffAction
        .findMany({ where: { at: { lt: before }, ...(who ? { OR: [{ targetId: who }, { staffId: who }] } : {}) }, orderBy: { at: 'desc' }, take })
        .then((rows) => rows.map((a) => ({ id: `staff:${a.id}`, at: a.at.toISOString(), kind: 'staff' as const, text: `${a.staffName}: ${ACTION[a.action] ?? a.action}${a.note ? `, ${a.note}` : ''}`, userId: a.targetKind === 'user' ? (a.targetId ?? undefined) : undefined }))),
    );

  return (await Promise.all(jobs))
    .flat()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, take);
}

const ACTION: Record<string, string> = {
  suspend: 'suspended an account',
  unsuspend: 'lifted a suspension',
  signOut: 'signed an account out everywhere',
  unlock: 'unlocked an account',
  setPlan: 'changed a plan',
  refund: 'refunded match passes',
  featureAccess: 'changed paid features',
  reviewCertificate: 'reviewed a certificate',
  issueApiKey: 'issued an API key',
  approveEmbeds: 'switched website embeds on',
  revokeEmbeds: 'switched website embeds off',
};

async function actionRows(where: P.Prisma.StaffActionWhereInput, take = 30): Promise<StaffActionRow[]> {
  const rows = await prisma.staffAction.findMany({ where, orderBy: { at: 'desc' }, take });
  return rows.map((a) => ({ id: a.id, at: a.at.toISOString(), staffName: a.staffName, action: ACTION[a.action] ?? a.action, targetKind: a.targetKind, targetId: a.targetId ?? undefined, note: a.note ?? undefined }));
}

// ------------------------------------------------------------------ one user

async function userDetail(id: string): Promise<StaffUserDetail> {
  const u = await prisma.user.findUnique({ where: { id }, include: { memberships: true, wallet: true } });
  if (!u) throw notFound('Account');
  const [sessions, lastSession, passes, checkouts, hostedSales, payouts, scored, umpired, stories, ratingsGiven, actions, acts] = await Promise.all([
    prisma.session.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.session.findFirst({ where: { userId: id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.matchPass.findMany({ where: { userId: id }, orderBy: { at: 'desc' }, take: 50 }),
    prisma.checkout.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.passSale.findMany({ where: { hostUserId: id } }),
    prisma.hostPayout.findMany({ where: { userId: id } }),
    // Counted as on their profile: matches under way or played, not ones still to come.
    prisma.match.count({ where: { scorerUserId: id, status: { in: PLAYED } } }),
    matchIdsWithOfficial('umpireUserIds', id).then((ids) => prisma.match.count({ where: { id: { in: ids }, status: { in: PLAYED } } })),
    prisma.story.count({ where: { authorId: id } }),
    prisma.rating.count({ where: { raterId: id } }),
    actionRows({ targetKind: 'user', targetId: id }),
    activity({ userId: id, take: 30 }),
  ]);
  const orgIds = u.memberships.map((m) => m.orgId).filter((x): x is string => !!x);
  const clubIds = u.memberships.map((m) => m.clubId).filter((x): x is string => !!x);
  const [orgs, clubs, labels] = await Promise.all([
    prisma.organisation.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true, currency: true } }),
    prisma.team.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } }),
    matchLabels(passes.map((p) => p.matchId)),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const hostCurrency = hostedSales.find((s) => s.currency)?.currency ?? payouts.find((p) => p.currency)?.currency ?? u.wallet?.currency ?? orgs[0]?.currency ?? currencyForCountry(u.country ?? undefined);
  return {
    user: { ...row(u), suspendedAt: iso(u.suspendedAt), suspendedReason: u.suspendedReason ?? undefined, deleteOn: iso(u.deleteOn), failedLogins: u.failedLogins },
    memberships: u.memberships.map((m) => ({
      role: ROLE[m.role] ?? m.role,
      name: (m.orgId ? orgName.get(m.orgId) : m.clubId ? clubName.get(m.clubId) : undefined) ?? 'Unknown',
      href: m.clubId ? `/clubs/${m.clubId}` : m.orgId ? `/organisations/${m.orgId}` : undefined,
    })),
    sessions: { active: sessions, lastSignIn: iso(lastSession?.createdAt) },
    wallet: u.wallet ? { balance: u.wallet.balance, currency: u.wallet.currency ?? hostCurrency ?? undefined } : undefined,
    passes: passes.map((p) => ({ id: p.id, at: p.at.toISOString(), matchId: p.matchId ?? undefined, label: p.matchId ? (labels.get(p.matchId)?.label ?? 'A match') : 'Season pass', price: p.price, currency: p.currency, paidWith: p.paidWith, status: p.status })),
    payments: checkouts.map((c) => ({ id: c.id, at: c.createdAt.toISOString(), kind: PAYMENT_NAME[c.kind] ?? c.kind, amount: c.amount, currency: c.currency, status: c.status, method: c.method })),
    hosting: hostedSales.length
      ? {
          matches: hostedSales.length,
          passes: hostedSales.reduce((s, x) => s + x.passes, 0),
          gross: hostedSales.reduce((s, x) => s + x.gross, 0),
          earned: hostedSales.reduce((s, x) => s + x.host, 0),
          paidOut: payouts.filter((p) => p.status === 'paid').reduce((s, x) => s + x.amount, 0),
          currency: hostCurrency ?? '',
        }
      : undefined,
    counts: { scored, umpired, stories, ratingsGiven },
    actions,
    activity: acts,
  };
}

// ------------------------------------------------------------------ routes

export async function backofficeRoutes(app: FastifyInstance) {
  app.get('/staff/overview', async (req): Promise<StaffOverview> => {
    requireStaff(req);
    const { days } = z.object({ days: daysParam }).parse(req.query);
    const from = since(days);
    const today = since(1);
    const [total, fresh, active, activeToday, suspended, locked, liveMatches, matchesPlayed, balls, liveStreams, streamSeconds, stories, streaming, dailyRows, credits, payments, failedPayments, owed, paid] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: from } } }),
      prisma.user.count({ where: { OR: [{ lastSeenAt: { gte: from } }, { sessions: { some: { createdAt: { gte: from } } } }] } }),
      prisma.user.count({ where: { OR: [{ lastSeenAt: { gte: today } }, { sessions: { some: { createdAt: { gte: today } } } }] } }),
      prisma.user.count({ where: { suspendedAt: { not: null } } }),
      prisma.user.count({ where: { lockedUntil: { gt: new Date() } } }),
      prisma.match.count({ where: { status: { in: ['live', 'inningsBreak'] } } }),
      prisma.match.count({ where: { status: 'completed', startsAt: { gte: from } } }),
      prisma.ballEvent.count({ where: { createdAt: { gte: from } } }),
      prisma.stream.count({ where: { status: 'live' } }),
      prisma.stream.aggregate({ _sum: { liveSeconds: true } }),
      prisma.story.count({ where: { createdAt: { gte: from } } }),
      passTotals({ at: { gte: from } }),
      // Pass sales per UTC day, for the chart.
      prisma.$queryRaw<{ day: string; currency: string; gross: bigint; ovalcast: bigint; passes: bigint }[]>`
        select to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, currency,
               sum(price) as gross, sum(price - coalesce(fee, 0) - coalesce(host_share, 0)) as ovalcast, count(*) as passes
        from match_passes where at >= ${from} and status <> 'refunded' group by 1, 2`,
      prisma.viewerCreditPurchase.groupBy({ by: ['orgId'], where: { at: { gte: from } }, _sum: { price: true, hours: true }, _count: { _all: true } }),
      prisma.checkout.groupBy({ by: ['kind', 'currency'], where: { status: 'paid', kind: { in: ['entry', 'pro', 'topUp'] }, paidAt: { gte: from } }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.checkout.count({ where: { status: 'failed', createdAt: { gte: from } } }),
      prisma.passSale.groupBy({ by: ['currency'], _sum: { host: true } }),
      prisma.hostPayout.groupBy({ by: ['currency'], where: { status: 'paid' }, _sum: { amount: true } }),
    ]);

    // Viewer hours are bought by organisations, in their own currency.
    // Viewer hours are bought by organisations, in their own currency.
    const orgs = await orgCurrencies(credits.map((c) => c.orgId));
    const creditBy = new Map<string, { currency: string; amount: number; hours: number; count: number }>();
    for (const c of credits) {
      const cur = orgs.get(c.orgId)?.currency ?? '';
      const t = creditBy.get(cur) ?? { currency: cur, amount: 0, hours: 0, count: 0 };
      t.amount += c._sum.price ?? 0;
      t.hours += c._sum.hours ?? 0;
      t.count += c._count._all;
      creditBy.set(cur, t);
    }

    // What streamers have earned against what they've been paid, per currency.
    const hostBy = new Map<string, { currency: string; paid: number; owed: number }>();
    for (const o of owed) hostBy.set(o.currency ?? '', { currency: o.currency ?? '', paid: 0, owed: o._sum.host ?? 0 });
    for (const p of paid) {
      const t = hostBy.get(p.currency ?? '') ?? { currency: p.currency ?? '', paid: 0, owed: 0 };
      t.paid += p._sum.amount ?? 0;
      t.owed -= p._sum.amount ?? 0;
      hostBy.set(t.currency, t);
    }

    // Every day in the range, so the chart has no gaps.
    const daily = new Map<string, StaffOverview['daily'][number]>();
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
      for (const t of streaming) daily.set(`${day}|${t.currency}`, { day, currency: t.currency, gross: 0, ovalcast: 0, passes: 0 });
    }
    for (const r of dailyRows) {
      const d = daily.get(`${r.day}|${r.currency}`);
      if (d) Object.assign(d, { gross: Number(r.gross), ovalcast: Number(r.ovalcast), passes: Number(r.passes) });
    }

    return {
      days,
      users: { total, new: fresh, active, activeToday, suspended, locked },
      cricket: { liveMatches, matchesPlayed, balls, liveStreams, streamHours: Math.round((streamSeconds._sum.liveSeconds ?? 0) / 360) / 10, stories },
      streaming,
      viewerCredits: [...creditBy.values()],
      payments: payments.map((p) => ({ kind: p.kind as 'entry' | 'pro' | 'topUp', currency: p.currency, amount: p._sum.amount ?? 0, count: p._count._all })).sort((a, b) => b.amount - a.amount),
      failedPayments,
      hostPayouts: [...hostBy.values()].map((h) => ({ ...h, owed: Math.max(0, h.owed) })),
      daily: [...daily.values()],
    };
  });

  app.get('/staff/users', async (req) => {
    requireStaff(req);
    const q = z.object({ q: z.string().trim().optional(), filter: z.enum(['all', 'new', 'active', 'suspended', 'locked', 'staff', 'unverified']).default('all'), before: z.string().optional() }).parse(req.query);
    const where: P.Prisma.UserWhereInput = {
      ...(q.q
        ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q.replace(/\s+/g, '') } }, { id: q.q }] }
        : {}),
      ...(q.filter === 'new' ? { createdAt: { gte: since(7) } } : {}),
      ...(q.filter === 'active' ? { lastSeenAt: { gte: since(7) } } : {}),
      ...(q.filter === 'suspended' ? { suspendedAt: { not: null } } : {}),
      ...(q.filter === 'locked' ? { lockedUntil: { gt: new Date() } } : {}),
      ...(q.filter === 'staff' ? { staff: true } : {}),
      ...(q.filter === 'unverified' ? { emailVerified: false, phoneVerified: false } : {}),
      ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
    };
    const users = await prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, include: { memberships: true } });
    return users.map(row);
  });

  app.get<{ Params: { id: string } }>('/staff/users/:id', async (req) => {
    requireStaff(req);
    return userDetail(req.params.id);
  });

  const endSessions = async (userId: string) => {
    await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    // Every server forgets the sessions it was holding.
    emit('responses:clear', null);
  };

  app.post<{ Params: { id: string } }>('/staff/users/:id/suspend', async (req) => {
    const staff = requireStaff(req);
    const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why, so whoever reads this later knows').max(300) }).parse(req.body);
    if (req.params.id === staff.id) throw badRequest('You can’t suspend your own account');
    const u = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!u) throw notFound('Account');
    await prisma.user.update({ where: { id: u.id }, data: { suspendedAt: new Date(), suspendedReason: reason } });
    await endSessions(u.id);
    await logStaff(staff, 'suspend', 'user', u.id, reason);
    return userDetail(u.id);
  });

  app.post<{ Params: { id: string } }>('/staff/users/:id/unsuspend', async (req) => {
    const staff = requireStaff(req);
    const u = await prisma.user.update({ where: { id: req.params.id }, data: { suspendedAt: null, suspendedReason: null } }).catch(() => undefined);
    if (!u) throw notFound('Account');
    emit('responses:clear', null);
    await logStaff(staff, 'unsuspend', 'user', u.id);
    return userDetail(u.id);
  });

  app.post<{ Params: { id: string } }>('/staff/users/:id/sign-out', async (req) => {
    const staff = requireStaff(req);
    if (!(await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true } }))) throw notFound('Account');
    await endSessions(req.params.id);
    await logStaff(staff, 'signOut', 'user', req.params.id);
    return userDetail(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/staff/users/:id/unlock', async (req) => {
    const staff = requireStaff(req);
    const u = await prisma.user.update({ where: { id: req.params.id }, data: { failedLogins: 0, lockedUntil: null } }).catch(() => undefined);
    if (!u) throw notFound('Account');
    await logStaff(staff, 'unlock', 'user', u.id);
    return userDetail(u.id);
  });

  app.get('/staff/activity', async (req) => {
    requireStaff(req);
    const q = z.object({ kind: z.enum(ACTIVITY_KINDS).optional(), userId: z.string().optional(), before: z.string().optional() }).parse(req.query);
    return activity({ kind: q.kind, userId: q.userId, before: q.before ? new Date(q.before) : undefined });
  });

  // ------------------------------------------------------------ shares
  // Ovalcast's platform share of paid streams and its share of entry fees: the global rates, and
  // the organisations and streamers with their own. Every change is a logged staff action.
  const share = z.number().min(0).max(0.9);
  app.get('/staff/shares', async (req): Promise<StaffShares> => {
    requireStaff(req);
    const [g, orgs, users] = await Promise.all([
      globalShares(),
      prisma.organisation.findMany({ where: { OR: [{ platformShare: { not: null } }, { entryShare: { not: null } }] }, select: { id: true, name: true, platformShare: true, entryShare: true }, orderBy: { name: 'asc' } }),
      prisma.user.findMany({ where: { platformShare: { not: null } }, select: { id: true, name: true, platformShare: true }, orderBy: { name: 'asc' } }),
    ]);
    return { ...g, organisations: orgs.map((o) => ({ orgId: o.id, name: o.name, platformShare: o.platformShare ?? undefined, entryShare: o.entryShare ?? undefined })), streamers: users.map((u) => ({ userId: u.id, name: u.name, platformShare: u.platformShare! })) };
  });
  app.put('/staff/shares', async (req) => {
    const staff = requireStaff(req);
    return setGlobalShares(staff, z.object({ platformShare: share.optional(), entryShare: share.optional() }).parse(req.body));
  });
  app.put<{ Params: { id: string } }>('/staff/organisations/:id/shares', async (req) => {
    const staff = requireStaff(req);
    return setOrganisationShares(staff, req.params.id, z.object({ platformShare: share.nullable().optional(), entryShare: share.nullable().optional() }).parse(req.body));
  });
  app.put<{ Params: { id: string } }>('/staff/users/:id/platform-share', async (req) => {
    const staff = requireStaff(req);
    return setStreamerShare(staff, req.params.id, z.object({ platformShare: share.nullable() }).parse(req.body).platformShare);
  });

  app.get('/staff/money', async (req): Promise<StreamingMoney> => {
    requireStaff(req);
    const { days } = z.object({ days: daysParam }).parse(req.query);
    const from = since(days);
    const [totals, groups, passes, credits, payouts] = await Promise.all([
      passTotals({ at: { gte: from } }),
      // Per match and streamer, added up by the database.
      prisma.matchPass.groupBy({ by: ['matchId', 'hostUserId', 'currency', 'status'], where: { at: { gte: from }, matchId: { not: null } }, _count: { _all: true }, _sum: { price: true, fee: true, hostShare: true } }),
      prisma.matchPass.findMany({ where: { at: { gte: from } }, orderBy: { at: 'desc' }, take: 100, include: { user: { select: { name: true } } } }),
      prisma.viewerCreditPurchase.findMany({ where: { at: { gte: from } }, orderBy: { at: 'desc' }, take: 200 }),
      prisma.hostPayout.findMany({ where: { at: { gte: from } }, orderBy: { at: 'desc' }, take: 200 }),
    ]);
    const matchIds = [...new Set(groups.map((g) => g.matchId!))];
    const hostIds = [...new Set([...groups.map((g) => g.hostUserId), ...payouts.map((p) => p.userId)])];
    const [labels, streams, offers, people, hostSales, hostPaid] = await Promise.all([
      matchLabels([...matchIds, ...passes.map((p) => p.matchId)]),
      prisma.stream.groupBy({ by: ['matchId'], where: { matchId: { in: matchIds } }, _sum: { liveSeconds: true }, _max: { refundedAt: true } }),
      prisma.passOffer.findMany({ where: { matchId: { in: matchIds } }, select: { matchId: true, hostName: true } }),
      prisma.user.findMany({ where: { id: { in: hostIds } }, select: { id: true, name: true } }).then((us) => new Map(us.map((u) => [u.id, u.name]))),
      // Per streamer, all time.
      prisma.passSale.groupBy({ by: ['hostUserId', 'currency'], where: { hostUserId: { in: hostIds } }, _sum: { passes: true, gross: true, host: true } }),
      prisma.hostPayout.groupBy({ by: ['userId', 'currency'], where: { userId: { in: hostIds }, status: 'paid' }, _sum: { amount: true } }),
    ]);
    const streamOf = new Map(streams.map((x) => [x.matchId, x]));
    const hostName = new Map(offers.map((o) => [o.matchId, o.hostName]));

    const byMatch = new Map<string, StreamingMoney['matches'][number]>();
    for (const g of groups) {
      const key = `${g.matchId}|${g.hostUserId}|${g.currency}`;
      const l = labels.get(g.matchId!);
      const st = streamOf.get(g.matchId!);
      const m = byMatch.get(key) ?? {
        matchId: g.matchId!,
        label: l?.label ?? 'A match',
        date: (l?.date ?? new Date()).toISOString(),
        hostUserId: g.hostUserId,
        hostName: hostName.get(g.matchId!) ?? people.get(g.hostUserId) ?? 'Host',
        currency: g.currency,
        passes: 0,
        gross: 0,
        refunded: 0,
        fees: 0,
        host: 0,
        ovalcast: 0,
        liveMinutes: Math.round((st?._sum.liveSeconds ?? 0) / 60),
        streamRefunded: !!st?._max.refundedAt,
      };
      addPasses(m, g.status, g, (n) => (m.host += n));
      byMatch.set(key, m);
    }

    const hosts = hostSales
      .map((h) => ({
        userId: h.hostUserId,
        name: people.get(h.hostUserId) ?? h.hostUserId,
        currency: h.currency ?? '',
        passes: h._sum.passes ?? 0,
        gross: h._sum.gross ?? 0,
        earned: h._sum.host ?? 0,
        paidOut: hostPaid.filter((p) => p.userId === h.hostUserId && (p.currency ?? '') === (h.currency ?? '')).reduce((t, p) => t + (p._sum.amount ?? 0), 0),
      }))
      .filter((h) => h.passes > 0)
      .sort((a, b) => b.gross - a.gross);

    const orgs = await orgCurrencies(credits.map((c) => c.orgId));
    return {
      days,
      totals,
      matches: [...byMatch.values()].sort((a, b) => b.gross - a.gross),
      hosts,
      passes: passes.map((p) => ({ id: p.id, at: p.at.toISOString(), userId: p.userId, userName: p.user.name, matchId: p.matchId ?? undefined, label: p.matchId ? (labels.get(p.matchId)?.label ?? 'A match') : 'Season pass', price: p.price, currency: p.currency, paidWith: p.paidWith, status: p.status,
        // How this sale divided, as stored when it was sold.
        fee: p.fee ?? 0, streamer: p.hostShare ?? 0, platform: p.price - (p.fee ?? 0) - (p.hostShare ?? 0), platformShare: p.platformShare ?? undefined })),
      viewerCredits: credits.map((c) => ({ id: c.id, at: c.at.toISOString(), orgId: c.orgId, orgName: orgs.get(c.orgId)?.name ?? c.orgId, hours: c.hours, price: c.price, currency: orgs.get(c.orgId)?.currency ?? '' })),
      payouts: payouts.map((p) => ({ id: p.id, at: p.at.toISOString(), userId: p.userId, userName: people.get(p.userId) ?? p.userId, amount: p.amount, currency: p.currency ?? '', status: p.status, reference: p.reference })),
    };
  });
}
