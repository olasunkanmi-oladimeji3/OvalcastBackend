// Player statistics, aggregated from the ball log of every scored match.
// Replays are cached per match and invalidated when the match gains events. The whole
// set is rebuilt only when something was scored, and at most every few seconds while
// matches are live, so career and leaderboard pages share one build.

import type { Match } from '@/api/types';
import { activeEvents, replay, type BallEvent, type MatchSetup, type MatchState } from '@/engine';
import { prisma } from '~/db/client';
import { registerCache } from '~/lib/cache';
import { toMatch } from '~/lib/repo';
import { ballEventsFor, currentStatsVersion, setupFor } from './matches';

interface Replayed {
  match: Match;
  setup: MatchSetup;
  state: MatchState;
  events: BallEvent[];
}

// Each match's replay, reused while its balls, XI and status are unchanged. Emptied with every other cache.
const cache = registerCache(new Map<string, { key: string; value: Replayed }>());

/** How stale stats may be while balls are coming in. */
const REBUILD_EVERY_MS = 10_000;
let built: { version: number; at: number; all: Promise<Replayed[]> } | undefined;
const filtered = new Map<string, Replayed[]>();
let rebuilding = false;
// Emptying every cache (the seed script, tests) starts the stats from scratch too.
registerCache({ clear: () => ((built = undefined), filtered.clear()) });

/** Builds the stats when the server starts, so the first visitor doesn't wait for it. */
export const warmStats = () => replayedMatches().then(() => undefined);

/** Every match with balls scored, replayed by the engine. Shared: don't change what's returned. */
export async function replayedMatches(filter?: { competitionId?: string; matchIds?: string[] }): Promise<Replayed[]> {
  const version = currentStatsVersion();
  if (!built) {
    // Nothing built yet (only at start-up): this request waits for the first build.
    const all = loadAll().catch((e) => {
      built = undefined;
      throw e;
    });
    built = { version, at: Date.now(), all };
    filtered.clear();
  } else if (built.version !== version && Date.now() - built.at > REBUILD_EVERY_MS && !rebuilding) {
    // Out of date: keep serving the last build while a new one is made in the background,
    // so no viewer ever waits for a rebuild.
    rebuilding = true;
    const startedAt = Date.now();
    void loadAll()
      .then((all) => {
        built = { version, at: startedAt, all: Promise.resolve(all) };
        filtered.clear();
      })
      .catch(() => {})
      .finally(() => (rebuilding = false));
  }
  const all = await built.all;
  if (!filter?.competitionId && !filter?.matchIds) return all;
  // The same filter returns the same array, so its figures are only added up once.
  const key = `${filter.competitionId ?? ''}|${filter.matchIds?.join(',') ?? ''}`;
  let out = filtered.get(key);
  if (!out) {
    out = all.filter((r) => (!filter.competitionId || r.match.competitionId === filter.competitionId) && (!filter.matchIds || filter.matchIds.includes(r.match.id)));
    filtered.set(key, out);
  }
  return out;
}

async function loadAll(): Promise<Replayed[]> {
  const counts = (await prisma.ballEvent.groupBy({ by: ['matchId'], _count: { _all: true } })).map((c) => ({ matchId: c.matchId, n: c._count._all }));
  const ids = counts.map((c) => c.matchId);
  if (!ids.length) return [];
  const rows = (await prisma.match.findMany({ where: { id: { in: ids } } })).map(toMatch);
  const out: Replayed[] = [];
  for (const match of rows) {
    const n = counts.find((c) => c.matchId === match.id)!.n;
    const key = `${n}:${match.playingXI ? 'xi' : ''}:${match.status}`;
    const hit = cache.get(match.id);
    if (hit && hit.key === key) {
      out.push({ ...hit.value, match });
      continue;
    }
    const [setup, events] = await Promise.all([setupFor(match), ballEventsFor(match.id)]);
    const value = { match, setup, events, state: replay(setup, events) };
    cache.set(match.id, { key, value });
    out.push(value);
  }
  return out;
}

export interface Figures {
  matches: number;
  innings: number;
  runs: number;
  balls: number;
  notOuts: number;
  high: number;
  fours: number;
  sixes: number;
  fifties: number;
  hundreds: number;
  ballsBowled: number;
  runsConceded: number;
  wickets: number;
  best: { wickets: number; runs: number } | undefined;
  catches: number;
  runOuts: number;
  stumpings: number;
  recent: { matchId: string; against: string; runs?: number; balls?: number; wickets?: number; conceded?: number; date: string }[];
}

const empty = (): Figures => ({ matches: 0, innings: 0, runs: 0, balls: 0, notOuts: 0, high: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0, ballsBowled: 0, runsConceded: 0, wickets: 0, best: undefined, catches: 0, runOuts: 0, stumpings: 0, recent: [] });

const totals = new WeakMap<Replayed[], Map<string, Figures>>();

/** Figures for every player who appears in the given replays. Shared: don't change what's returned. */
export function aggregate(replays: Replayed[]): Map<string, Figures> {
  const hit = totals.get(replays);
  if (hit) return hit;
  const out = addUp(replays);
  totals.set(replays, out);
  return out;
}

function addUp(replays: Replayed[]): Map<string, Figures> {
  const out = new Map<string, Figures>();
  const get = (id: string) => out.get(id) ?? (out.set(id, empty()), out.get(id)!);
  for (const r of [...replays].sort((a, b) => b.match.startsAt.localeCompare(a.match.startsAt))) {
    const teamOf = new Map(r.setup.teams.flatMap((t) => t.players.map((p) => [p.id, t.id] as const)));
    const per = new Map<string, Figures['recent'][0]>();
    const line = (id: string) => per.get(id) ?? (per.set(id, { matchId: r.match.id, against: teamOf.get(id) === r.match.homeTeamId ? r.match.awayTeamId : r.match.homeTeamId, date: r.match.startsAt }), per.get(id)!);
    for (const t of r.setup.teams) for (const p of t.players) get(p.id).matches += 1;
    for (const inn of r.state.innings) {
      for (const b of inn.batters) {
        const f = get(b.playerId);
        f.innings += 1;
        f.runs += b.runs;
        f.balls += b.balls;
        f.fours += b.fours;
        f.sixes += b.sixes;
        if (!b.out) f.notOuts += 1;
        f.high = Math.max(f.high, b.runs);
        if (b.runs >= 100) f.hundreds += 1;
        else if (b.runs >= 50) f.fifties += 1;
        Object.assign(line(b.playerId), { runs: b.runs, balls: b.balls });
      }
      for (const b of inn.bowlers) {
        const f = get(b.playerId);
        f.ballsBowled += b.balls;
        f.runsConceded += b.runs;
        f.wickets += b.wickets;
        if (!f.best || b.wickets > f.best.wickets || (b.wickets === f.best.wickets && b.runs < f.best.runs)) f.best = { wickets: b.wickets, runs: b.runs };
        Object.assign(line(b.playerId), { wickets: b.wickets, conceded: b.runs });
      }
    }
    for (const e of activeEvents(r.events)) {
      const w = e.wicket;
      if (!w?.fielderId) continue;
      const f = get(w.fielderId);
      if (w.kind === 'caught') f.catches += 1;
      if (w.kind === 'runOut') f.runOuts += 1;
      if (w.kind === 'stumped') f.stumpings += 1;
    }
    for (const [id, l] of per) {
      const f = get(id);
      if (f.recent.length < 5) f.recent.push(l);
    }
  }
  return out;
}

export async function teamIdsInCities(cities: string[]) {
  const rows = await prisma.team.findMany({ where: { city: { in: cities } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** One record from several: a player and the typed-in records they claimed. */
export function mergeFigures(list: Figures[]): Figures | undefined {
  if (!list.length) return undefined;
  const sum = (k: keyof Figures) => list.reduce((s, f) => s + (f[k] as number), 0);
  const best = list.map((f) => f.best).filter((b): b is NonNullable<Figures['best']> => !!b).sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];
  return {
    matches: sum('matches'), innings: sum('innings'), runs: sum('runs'), balls: sum('balls'), notOuts: sum('notOuts'), high: Math.max(...list.map((f) => f.high)),
    fours: sum('fours'), sixes: sum('sixes'), fifties: sum('fifties'), hundreds: sum('hundreds'), ballsBowled: sum('ballsBowled'), runsConceded: sum('runsConceded'), wickets: sum('wickets'),
    best, catches: sum('catches'), runOuts: sum('runOuts'), stumpings: sum('stumpings'),
    recent: list.flatMap((f) => f.recent).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
  };
}
