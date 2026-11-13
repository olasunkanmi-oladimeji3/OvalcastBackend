// Match state from the ball log: every score, status and result is recalculated
// by the shared engine from ball_events, never edited directly.
//
// Live matches are held in memory: the match, its balls and its two XIs. A new ball is
// one insert and one update, and viewers read the held copy instead of Postgres.

import type { Match, Player } from '@/api/types';
import { replay, type BallEvent, type MatchSetup, type PlayingConditions } from '@/engine';
import { json, prisma } from '~/db/client';
import { emit, on } from '~/lib/bus';
import { TtlCache, registerCache } from '~/lib/cache';
import { notFound } from '~/lib/errors';
import { tapLive } from '~/lib/live';
import { followerIds, matchData, notify, toMatch, toPlayer } from '~/lib/repo';

export const T20: PlayingConditions = { ballsPerOver: 6, oversPerInnings: 20, wideRuns: 1, noBallRuns: 1, freeHit: true, maxOversPerBowler: 4, powerplayOvers: 6, superOver: true };

// ------------------------------------------------------------------ caches
/** Matches as viewers see them. Saves write through; other changes expire within seconds. */
const matches = registerCache(new TtlCache<Match>(2000));
const MATCH_TTL = 5_000;
/** Each match's ball log, in order, loaded once and appended to as balls arrive. */
const balls = registerCache(new TtlCache<{ events: BallEvent[]; ids: Set<string>; clientIds: Set<string> }>(500));
const BALLS_TTL = 30 * 60_000;
/** Each match's two XIs for the engine. Keyed by everything they're built from. */
const setups = registerCache(new TtlCache<MatchSetup>(500));
/** The phone scoring each match, so every ball doesn't look it up. */
const devices = registerCache(new Map<string, string>());

/** The match from Postgres. For anything that changes it. */
export async function getMatch(id: string): Promise<Match> {
  const m = await prisma.match.findUnique({ where: { id } });
  if (!m) throw notFound('Match');
  return toMatch(m);
}

/** The match for reading: held in memory, at most a few seconds behind. Don't change it. */
export const getMatchCached = (id: string): Promise<Match> => matches.remember(id, MATCH_TTL, () => getMatch(id));

export async function saveMatch(m: Match) {
  const row = await prisma.match.update({ where: { id: m.id }, data: matchData(m) });
  emit('match:changed', { id: m.id, match: structuredClone(m) });
  return row;
}

/** Forget a match that was changed some other way, here and on every other server process. */
export const forgetMatch = (id: string) => emit('match:changed', { id });

/** When each match last changed, so a viewer connecting with an older page can be sent the new one. */
const changedAt = new Map<string, number>();
export const matchChangedAt = (id: string) => changedAt.get(id);

on('match:changed', (data) => {
  const { id, match } = data as { id: string; match?: Match };
  changedAt.set(id, Date.now());
  if (match) matches.set(id, match, MATCH_TTL);
  else matches.delete(id);
  statsChanged();
});

/** The match's balls in order. The same array is shared: don't change it. */
export async function ballEventsFor(matchId: string): Promise<BallEvent[]> {
  return (await ballLog(matchId)).events;
}

const ballLog = (matchId: string) =>
  balls.remember(matchId, BALLS_TTL, async () => {
    const rows = await prisma.ballEvent.findMany({ where: { matchId }, orderBy: { createdAt: 'asc' }, select: { event: true } });
    const events = rows.map((r) => json<BallEvent>(r.event));
    return { events, ids: new Set(events.map((e) => e.id)), clientIds: new Set(events.map((e) => e.clientId)) };
  });

/** A ball already stored for this client id (a retried offline sync), from memory. */
export async function storedBall(matchId: string, clientId: string) {
  const log = await ballLog(matchId);
  return log.clientIds.has(clientId) ? log.events.find((e) => e.clientId === clientId) : undefined;
}

/** Adds a new ball to the held log, if this process holds it. */
function append(matchId: string, event: BallEvent) {
  const log = balls.get(matchId);
  if (log && !log.ids.has(event.id)) {
    log.events.push(event);
    log.ids.add(event.id);
    log.clientIds.add(event.clientId);
    balls.set(matchId, log, BALLS_TTL);
  }
  statsChanged();
}

// Every process hears every ball through the live feed, so each keeps its copy current.
tapLive((matchId, msg) => {
  if (msg.type === 'ball' || msg.type === 'void') append(matchId, msg.event);
  else if (msg.type === 'status') {
    matches.set(matchId, msg.match, MATCH_TTL);
    changedAt.set(matchId, Date.now());
  }
});

/** Records the match's new ball in memory straight after it's stored. */
export const ballStored = (matchId: string, event: BallEvent) => append(matchId, event);

/** The phone allowed to score this match, if one has claimed it. */
export async function scoringDevice(matchId: string) {
  if (devices.has(matchId)) return devices.get(matchId) || undefined;
  const row = await prisma.match.findUnique({ where: { id: matchId }, select: { scoringDeviceId: true } });
  devices.set(matchId, row?.scoringDeviceId ?? '');
  return row?.scoringDeviceId ?? undefined;
}
/** After a handover or claim: every process looks the phone up again. */
export const forgetDevice = (matchId: string) => emit('device:changed', matchId);
on('device:changed', (id) => devices.delete(id as string));

// ------------------------------------------------------------------ stats
let statsVersion = 0;
const statsListeners = new Set<() => void>();
/** Something scored changed: stats built from the ball log are out of date. */
export function statsChanged() {
  statsVersion += 1;
  statsListeners.forEach((f) => f());
}
export const currentStatsVersion = () => statsVersion;

/** The engine's view of a match: conditions, and each side's XI (or the first eleven of the squad). */
export function setupFor(m: Match): Promise<MatchSetup> {
  const key = JSON.stringify([m.id, m.competitionId, m.homeTeamId, m.awayTeamId, m.playingXI, m.conditions, m.battingFirstTeamId, m.reduced]);
  return setups.remember(key, 10 * 60_000, () => buildSetup(m));
}
/** Squad changes (a player added or renamed) rebuild the XIs. */
export const forgetSetups = () => emit('setups:changed', null);
on('setups:changed', () => setups.clear());

async function buildSetup(m: Match): Promise<MatchSetup> {
  const comp = m.competitionId ? await prisma.competition.findUnique({ where: { id: m.competitionId } }) : null;
  const ids = [m.homeTeamId, m.awayTeamId].filter(Boolean);
  const teamRows = await prisma.team.findMany({ where: { id: { in: ids } } });
  // Practice sides pick from their club's squad.
  const parents = teamRows.map((t) => t.parentTeamId).filter((x): x is string => !!x);
  const playerRows = await prisma.player.findMany({ where: { teamId: { in: [...ids, ...parents] } } });
  // Players registered with a club as its second club in this league also belong to its squad.
  const dualRegs = m.competitionId ? await prisma.registration.findMany({ where: { competitionId: m.competitionId, teamId: { in: ids }, status: 'active', primary: false } }) : [];
  const dualPlayers = dualRegs.length ? (await prisma.player.findMany({ where: { id: { in: dualRegs.map((r) => r.playerId) } } })).map(toPlayer) : [];
  const build = (teamId: string) => {
    const t = teamRows.find((x) => x.id === teamId)!;
    const squad: Player[] = [...playerRows.filter((p) => p.teamId === teamId || (!!t.parentTeamId && p.teamId === t.parentTeamId)).map(toPlayer), ...dualPlayers.filter((p) => dualRegs.some((r) => r.playerId === p.id && r.teamId === teamId))];
    const xi = m.playingXI?.[teamId];
    const chosen = xi ? xi.map((pid) => squad.find((p) => p.id === pid)).filter((p): p is Player => !!p) : squad.filter((p) => !p.guest).slice(0, 11);
    // The rest of the squad can come on as substitute fielders: the 12th man (Law 24).
    const picked = new Set(chosen.map((p) => p.id));
    const substitutes = squad.filter((p) => !p.guest && !picked.has(p.id));
    return { id: t.id, name: t.name, shortName: t.shortName, players: chosen.map((p) => ({ id: p.id, name: p.name, shortName: p.shortName })), substitutes: substitutes.map((p) => ({ id: p.id, name: p.name, shortName: p.shortName })) };
  };
  return {
    conditions: m.conditions ?? (comp ? json<PlayingConditions>(comp.conditions) : T20),
    teams: [build(m.homeTeamId), build(m.awayTeamId)],
    battingFirstTeamId: m.battingFirstTeamId ?? m.homeTeamId,
    reduced: m.reduced ? { overs: m.reduced.overs, target: m.reduced.target, rule: m.reduced.rule } : undefined,
  };
}

/** Recalculates scores, status and result from the events, saves them, and moves a knockout winner on. */
export async function refreshFromEvents(m: Match, statusBefore?: Match['status']): Promise<Match> {
  if (!m.battingFirstTeamId) return m;
  const [events, setup] = await Promise.all([ballEventsFor(m.id), setupFor(m)]);
  const state = replay(setup, events);
  const lastOut = (teamId: string) => setup.teams.find((t) => t.id === teamId)!.players.length - 1;
  m.scores = state.innings
    .filter((i) => i.legalBalls > 0 || i.runs > 0 || i.number === 1)
    .map((i) => ({ teamId: i.battingTeamId, runs: i.runs, wickets: i.wickets, balls: i.legalBalls, allOut: i.wickets >= lastOut(i.battingTeamId) }));
  if (state.result) {
    m.status = 'completed';
    m.result = { text: state.result.text, winnerTeamId: state.result.winnerTeamId, outcome: state.result.kind === 'tie' ? 'tie' : 'win' };
  } else if (events.length > 0) {
    m.status = state.innings.length === 2 && state.innings[1].legalBalls === 0 && state.innings[0].complete ? 'inningsBreak' : 'live';
    m.result = undefined;
  }
  const wasCompleted = (statusBefore ?? (await prisma.match.findUnique({ where: { id: m.id }, select: { status: true } }))?.status) === 'completed';
  await saveMatch(m);
  if (m.status === 'completed' && !wasCompleted) await tellFollowers(m);
  if (m.status === 'completed' && m.winnerTo && m.result?.winnerTeamId) {
    const next = await getMatch(m.winnerTo.matchId);
    if (m.winnerTo.side === 'home') next.homeTeamId = m.result.winnerTeamId;
    else next.awayTeamId = m.result.winnerTeamId;
    const home = await prisma.team.findUnique({ where: { id: next.homeTeamId || m.result.winnerTeamId } });
    if (home) next.venue = home.homeGround;
    await saveMatch(next);
  }
  return m;
}

/** People following either club or the competition hear the result. */
async function tellFollowers(m: Match) {
  const users = await followerIds([m.homeTeamId, m.awayTeamId], m.competitionId ? [m.competitionId] : []);
  if (users.length && m.result) await notify(users, { kind: 'result', title: m.result.text, body: 'A club you follow has finished a match.', link: { pathname: '/match/[id]', params: { id: m.id } } });
}
