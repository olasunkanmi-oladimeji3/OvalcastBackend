// Row → API contract mappers and shared lookups. Routes return exactly the
// shapes in mobile/src/api/types.ts, so the app and website need no changes.

import type { AppNotification, Competition, CompetitionEntry, Match, Organisation, Player, Team, Transfer, User, UserSettings } from '@/api/types';
import type * as P from '~/generated/prisma/client';
import { Prisma, json, prisma, toJson } from '~/db/client';
import { newId } from './ids';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export const toUser = (u: P.User, memberships: P.Membership[], assignedMatchIds: string[]): User => ({
  id: u.id,
  name: u.name,
  email: u.email ?? undefined,
  phone: u.phone ?? undefined,
  emailVerified: u.emailVerified,
  phoneVerified: u.phoneVerified,
  city: u.city ?? undefined,
  playerId: u.playerId ?? undefined,
  settings: json<UserSettings>(u.settings),
  memberships: memberships.map((m) => ({ orgId: m.orgId ?? undefined, clubId: m.clubId ?? undefined, role: m.role as User['memberships'][0]['role'] })),
  assignedMatchIds,
  country: u.country ?? undefined,
  staff: u.staff || undefined,
  playing: json<User['playing'] | null>(u.playing) ?? undefined,
  follows: { teamIds: [], playerIds: [], competitionIds: [], ...json<Partial<NonNullable<User['follows']>>>(u.follows) },
});

export async function loadUser(userId: string): Promise<User | undefined> {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { memberships: true } });
  if (!u) return undefined;
  const scoring = await prisma.match.findMany({ where: { scorerUserId: userId }, select: { id: true } });
  return toUser(u, u.memberships, scoring.map((m) => m.id));
}

export const toOrg = (o: P.Organisation, competitionIds: string[], clubIds: string[]): Organisation => ({
  id: o.id,
  name: o.name,
  shortName: o.shortName,
  city: o.city,
  country: o.country,
  currency: o.currency as Organisation['currency'],
  about: o.about,
  founded: o.founded,
  executives: json(o.executives),
  sponsors: json(o.sponsors),
  honours: json(o.honours),
  seasonMoves: json(o.seasonMoves),
  competitionIds,
  clubIds,
  kind: o.kind as Organisation['kind'],
  plan: o.plan as Organisation['plan'],
  logoUrl: o.logoUrl ?? undefined,
  coverUrl: o.coverUrl ?? undefined,
  brandColor: o.brandColor ?? undefined,
});

export const toTeam = (t: P.Team): Team => ({
  id: t.id,
  orgId: t.orgId ?? undefined,
  name: t.name,
  shortName: t.shortName,
  colors: json(t.colors),
  homeGround: t.homeGround,
  city: t.city,
  founded: t.founded,
  logoUrl: t.logoUrl ?? undefined,
  staff: json(t.staff),
  adHoc: t.adHoc || undefined,
  parentTeamId: t.parentTeamId ?? undefined,
});

export const toPlayer = (p: P.Player): Player => ({
  id: p.id,
  teamId: p.teamId,
  name: p.name,
  shortName: p.shortName,
  role: p.role as Player['role'],
  battingHand: p.battingHand as Player['battingHand'],
  bowlingStyle: p.bowlingStyle ?? undefined,
  guest: p.guest || undefined,
  guestMatchId: p.guestMatchId ?? undefined,
  minor: p.minor || undefined,
  guardianConsent: p.minor ? p.guardianConsent : undefined,
});

export const toCompetition = (c: P.Competition): Competition => ({
  id: c.id,
  orgId: c.orgId,
  seriesId: c.seriesId,
  name: c.name,
  season: c.season,
  division: c.division,
  format: c.format as Competition['format'],
  ballType: c.ballType as Competition['ballType'],
  conditions: json(c.conditions),
  points: json(c.points),
  tieBreakers: json(c.tieBreakers),
  stages: json(c.stages),
  teamIds: json(c.teamIds),
  status: c.status as Competition['status'],
  entryPolicy: c.entryPolicy as Competition['entryPolicy'],
  entryFee: c.entryFee,
  maxTeams: c.maxTeams,
  startsOn: c.startsOn.toISOString(),
  playerRules: json(c.playerRules),
  rulesDocument: json(c.rulesDocument) ?? undefined,
  seasonRules: json(c.seasonRules),
  category: c.category as Competition['category'],
  logoUrl: c.logoUrl ?? undefined,
  coverUrl: c.coverUrl ?? undefined,
  tier: c.tier ?? undefined,
  rainRule: c.rainRule as Competition['rainRule'],
});

export const toMatch = (m: P.Match): Match => ({
  id: m.id,
  competitionId: m.competitionId ?? undefined,
  stageId: m.stageId ?? undefined,
  groupId: m.groupId ?? undefined,
  title: m.title ?? undefined,
  homeTeamId: m.homeTeamId,
  awayTeamId: m.awayTeamId,
  venue: m.venue,
  startsAt: m.startsAt.toISOString(),
  status: m.status as Match['status'],
  toss: json(m.toss) ?? undefined,
  battingFirstTeamId: m.battingFirstTeamId ?? undefined,
  playingXI: json(m.playingXI) ?? undefined,
  officials: json(m.officials),
  scores: json(m.scores),
  result: json(m.result) ?? undefined,
  locked: m.locked,
  streamId: m.streamId ?? undefined,
  friendly: m.friendly || undefined,
  conditions: json(m.conditions) ?? undefined,
  round: m.round ?? undefined,
  placeholders: json(m.placeholders) ?? undefined,
  winnerTo: json(m.winnerTo) ?? undefined,
  createdBy: m.createdBy ?? undefined,
  leaders: json(m.leaders) ?? undefined,
  practice: m.practice || undefined,
  playerOfMatchId: m.playerOfMatchId ?? undefined,
  outcomeNote: m.outcomeNote ?? undefined,
  reduced: json<Match['reduced'] | null>(m.reduced) ?? undefined,
  decision: json<Match['decision'] | null>(m.decision) ?? undefined,
});

/** Columns to write when a Match changes. Keeps the scorer index in step with `officials`. */
export const matchData = (m: Match) => ({
  competitionId: m.competitionId ?? null,
  stageId: m.stageId ?? null,
  groupId: m.groupId ?? null,
  title: m.title ?? null,
  homeTeamId: m.homeTeamId,
  awayTeamId: m.awayTeamId,
  venue: m.venue,
  startsAt: m.startsAt,
  status: m.status,
  toss: toJson(m.toss),
  battingFirstTeamId: m.battingFirstTeamId ?? null,
  playingXI: toJson(m.playingXI),
  officials: toJson(m.officials),
  scores: toJson(m.scores),
  result: toJson(m.result),
  locked: m.locked,
  streamId: m.streamId ?? null,
  friendly: !!m.friendly,
  conditions: toJson(m.conditions),
  round: m.round ?? null,
  placeholders: toJson(m.placeholders),
  winnerTo: toJson(m.winnerTo),
  createdBy: m.createdBy ?? null,
  scorerUserId: m.officials.scorerUserId ?? null,
  leaders: toJson(m.leaders),
  practice: !!m.practice,
  playerOfMatchId: m.playerOfMatchId ?? null,
  outcomeNote: m.outcomeNote ?? null,
  reduced: m.reduced ? toJson(m.reduced) : Prisma.DbNull,
  decision: m.decision ? toJson(m.decision) : Prisma.DbNull,
});

export const toEntry = (e: P.Entry): CompetitionEntry => ({
  id: e.id,
  competitionId: e.competitionId,
  teamId: e.teamId,
  kind: e.kind as CompetitionEntry['kind'],
  status: e.status as CompetitionEntry['status'],
  message: e.message ?? undefined,
  createdAt: e.createdAt.toISOString(),
  respondedAt: iso(e.respondedAt),
  payment: json(e.payment) ?? undefined,
});

export const toTransfer = (t: P.Transfer): Transfer => ({
  id: t.id,
  competitionId: t.competitionId,
  playerId: t.playerId,
  fromTeamId: t.fromTeamId,
  toTeamId: t.toTeamId,
  kind: t.kind as Transfer['kind'],
  status: t.status as Transfer['status'],
  note: t.note ?? undefined,
  createdAt: t.createdAt.toISOString(),
  history: json(t.history),
  startedBy: json<Transfer['history']>(t.history)[0]?.by === 'player' ? 'player' : 'club',
});

export const toDeduction = (d: P.Deduction) => ({ ...d, matchId: d.matchId ?? undefined, at: d.at.toISOString(), revokedAt: iso(d.revokedAt) });
export const toRegistration = (r: P.Registration) => ({ ...r, since: r.since.toISOString(), status: r.status as 'active' | 'ended' });

// ------------------------------------------------------------ permissions

export const isLeagueAdmin = (u: User | undefined, orgId?: string) =>
  !!u && !!orgId && u.memberships.some((m) => m.orgId === orgId && (m.role === 'leagueAdmin' || m.role === 'owner'));
export const isClubAdmin = (u: User | undefined, teamId?: string) => !!u && !!teamId && u.memberships.some((m) => m.clubId === teamId && m.role === 'clubAdmin');

// ---------------------------------------------------------- notifications

export async function notify(userIds: string | string[], n: Omit<AppNotification, 'id' | 'at' | 'read' | 'userId'>) {
  const ids = [...new Set(Array.isArray(userIds) ? userIds : [userIds])];
  if (!ids.length) return;
  // Production also fans out to push, SMS and WhatsApp according to each user's settings.
  await prisma.notification.createMany({ data: ids.map((userId) => ({ id: newId('n'), userId, kind: n.kind, title: n.title, body: n.body, link: toJson(n.link) })) });
}

export async function clubAdminIds(teamId: string) {
  const rows = await prisma.membership.findMany({ where: { clubId: teamId, role: 'clubAdmin' }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

/**
 * Matches with this person in a list inside `officials` (umpires, groundsmen). Containment (@>)
 * so the GIN index on officials is used; Prisma's path filters can't use it.
 */
export async function matchIdsWithOfficial(key: 'umpireUserIds' | 'groundsmanUserIds', userId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`select id from matches where officials @> ${JSON.stringify({ [key]: [userId] })}::jsonb`;
  return rows.map((r) => r.id);
}

/** Accounts following any of these clubs or competitions, by the GIN index on follows. */
export async function followerIds(teamIds: string[], competitionIds: string[]): Promise<string[]> {
  const docs = [...teamIds.map((id) => ({ teamIds: [id] })), ...competitionIds.map((id) => ({ competitionIds: [id] }))].map((d) => JSON.stringify(d));
  if (!docs.length) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`select id from users where follows @> any(${docs}::jsonb[])`;
  return rows.map((r) => r.id);
}
