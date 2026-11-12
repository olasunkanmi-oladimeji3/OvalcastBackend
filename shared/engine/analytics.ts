// Match analytics and awards, calculated from the ball events like everything
// else, so they always agree with the scorecard.

import { activeEvents, deliveryRuns, isLegal } from './engine';
import type { BallEvent, MatchSetup, MatchState } from './types';

export interface PhaseStats {
  name: string;
  fromOver: number;
  toOver: number;
  runs: number;
  wickets: number;
  balls: number;
  boundaries: number;
  dots: number;
}

export interface InningsAnalytics {
  number: number;
  battingTeamId: string;
  phases: PhaseStats[];
  legalBalls: number;
  dots: number;
  fours: number;
  sixes: number;
  boundaryRuns: number;
  runs: number;
  extras: number;
  bestOver?: { number: number; runs: number; bowlerId: string };
  /** Longest run of legal balls without a four or six. */
  longestDrought: number;
  batters: { playerId: string; runs: number; balls: number; dots: number; boundaryRuns: number }[];
  bowlers: { playerId: string; balls: number; runs: number; dots: number; wickets: number }[];
}

/** Powerplay, middle and death overs. Death is the last fifth of the innings. */
export function phasesFor(overs: number, powerplay: number): { name: string; fromOver: number; toOver: number }[] {
  const deathFrom = Math.max(powerplay + 1, overs - Math.max(1, Math.round(overs / 5)) + 1);
  const phases = [{ name: 'Powerplay', fromOver: 1, toOver: Math.min(powerplay, overs) }];
  if (deathFrom - 1 > powerplay) phases.push({ name: 'Middle overs', fromOver: powerplay + 1, toOver: deathFrom - 1 });
  if (deathFrom <= overs) phases.push({ name: 'Death overs', fromOver: deathFrom, toOver: overs });
  return phases;
}

const BOWLER_WICKETS = ['bowled', 'caught', 'lbw', 'stumped', 'hitWicket'];

export function analyseInnings(setup: MatchSetup, events: BallEvent[], innings: number, battingTeamId: string): InningsAnalytics {
  const c = setup.conditions;
  const phases: PhaseStats[] = phasesFor(c.oversPerInnings, c.powerplayOvers).map((p) => ({ ...p, runs: 0, wickets: 0, balls: 0, boundaries: 0, dots: 0 }));
  const a: InningsAnalytics = { number: innings, battingTeamId, phases, legalBalls: 0, dots: 0, fours: 0, sixes: 0, boundaryRuns: 0, runs: 0, extras: 0, longestDrought: 0, batters: [], bowlers: [] };
  const bat = (id: string) => a.batters.find((b) => b.playerId === id) ?? (a.batters.push({ playerId: id, runs: 0, balls: 0, dots: 0, boundaryRuns: 0 }), a.batters[a.batters.length - 1]);
  const bowl = (id: string) => a.bowlers.find((b) => b.playerId === id) ?? (a.bowlers.push({ playerId: id, balls: 0, runs: 0, dots: 0, wickets: 0 }), a.bowlers[a.bowlers.length - 1]);
  const overRuns = new Map<number, { runs: number; bowlerId: string }>();
  let drought = 0;

  for (const e of activeEvents(events).filter((x) => x.innings === innings)) {
    const legal = isLegal(e);
    const overNo = Math.floor(a.legalBalls / c.ballsPerOver) + 1;
    const runs = deliveryRuns(e, setup);
    const phase = phases.find((p) => overNo >= p.fromOver && overNo <= p.toOver);
    const boundary = !!e.boundary && (e.bat === 4 || e.bat === 6);
    const wicket = !!e.wicket && e.wicket.kind !== 'retiredHurt';
    const kind = e.extra?.kind;

    a.runs += runs;
    if (kind) a.extras += runs - e.bat;
    if (phase) {
      phase.runs += runs;
      if (legal) phase.balls += 1;
      if (boundary) phase.boundaries += 1;
      if (wicket) phase.wickets += 1;
      if (legal && runs === 0) phase.dots += 1;
    }
    if (legal) {
      a.legalBalls += 1;
      if (runs === 0) a.dots += 1;
      drought = boundary ? 0 : drought + 1;
      a.longestDrought = Math.max(a.longestDrought, drought);
    }
    if (boundary) {
      if (e.bat === 4) a.fours += 1;
      else a.sixes += 1;
      a.boundaryRuns += e.bat;
    }

    const o = overRuns.get(overNo) ?? { runs: 0, bowlerId: e.bowlerId };
    o.runs += runs;
    overRuns.set(overNo, o);

    if (kind !== 'wide' && kind !== 'penalty') {
      const b = bat(e.strikerId);
      b.balls += 1;
      b.runs += e.bat;
      if (e.bat === 0) b.dots += 1;
      if (boundary) b.boundaryRuns += e.bat;
    }
    const bw = bowl(e.bowlerId);
    if (legal) bw.balls += 1;
    if (legal && runs === 0) bw.dots += 1;
    if (kind !== 'bye' && kind !== 'legBye' && kind !== 'penalty') bw.runs += kind === 'noBall' && e.extra!.nbVia && e.extra!.nbVia !== 'bat' ? runs - e.extra!.runs : runs;
    if (wicket && BOWLER_WICKETS.includes(e.wicket!.kind)) bw.wickets += 1;
  }

  for (const [number, o] of overRuns) {
    if (!a.bestOver || o.runs > a.bestOver.runs) a.bestOver = { number, runs: o.runs, bowlerId: o.bowlerId };
  }
  return a;
}

export interface PlayerImpact {
  playerId: string;
  teamId: string;
  batting: number;
  bowling: number;
  fielding: number;
  total: number;
}

export interface MatchAwards {
  bestBatter?: { playerId: string; teamId: string; runs: number; balls: number; fours: number; sixes: number };
  bestBowler?: { playerId: string; teamId: string; wickets: number; runs: number; balls: number };
  bestFielder?: { playerId: string; teamId: string; catches: number; runOuts: number; stumpings: number };
  /** Suggested from the impact score; the organiser confirms it. */
  playerOfMatch?: PlayerImpact;
  impacts: PlayerImpact[];
}

/**
 * Impact score: runs with a bonus or penalty for strike rate against the
 * match's own rate, 20 per wicket with an economy adjustment, and points for
 * catches, run outs and stumpings. The winning side gets a small bonus.
 */
export function matchAwards(setup: MatchSetup, state: MatchState, events: BallEvent[]): MatchAwards {
  const teamOf = new Map(setup.teams.flatMap((t) => t.players.map((p) => [p.id, t.id] as const)));
  const totalRuns = state.innings.reduce((s, i) => s + i.runs, 0);
  const totalBalls = state.innings.reduce((s, i) => s + i.legalBalls, 0);
  const matchRate = totalBalls ? totalRuns / totalBalls : 1.2; // runs per ball
  const impact = new Map<string, PlayerImpact>();
  const get = (id: string) => {
    if (!impact.has(id)) impact.set(id, { playerId: id, teamId: teamOf.get(id) ?? '', batting: 0, bowling: 0, fielding: 0, total: 0 });
    return impact.get(id)!;
  };
  const fielding = new Map<string, { catches: number; runOuts: number; stumpings: number }>();

  let bestBatter: MatchAwards['bestBatter'];
  let bestBowler: MatchAwards['bestBowler'];
  for (const inn of state.innings) {
    for (const b of inn.batters) {
      const p = get(b.playerId);
      p.batting += b.runs + (b.runs - b.balls * matchRate) * 0.5;
      if (!bestBatter || b.runs > bestBatter.runs || (b.runs === bestBatter.runs && b.balls < bestBatter.balls)) {
        bestBatter = { playerId: b.playerId, teamId: teamOf.get(b.playerId) ?? '', runs: b.runs, balls: b.balls, fours: b.fours, sixes: b.sixes };
      }
    }
    for (const b of inn.bowlers) {
      const p = get(b.playerId);
      p.bowling += b.wickets * 20 + (b.balls * matchRate - b.runs) * 0.8 + b.maidens * 6;
      const better = !bestBowler || b.wickets > bestBowler.wickets || (b.wickets === bestBowler.wickets && b.runs / Math.max(1, b.balls) < bestBowler.runs / Math.max(1, bestBowler.balls));
      if (b.balls > 0 && better) bestBowler = { playerId: b.playerId, teamId: teamOf.get(b.playerId) ?? '', wickets: b.wickets, runs: b.runs, balls: b.balls };
    }
  }
  for (const e of activeEvents(events)) {
    const w = e.wicket;
    if (!w?.fielderId) continue;
    const f = fielding.get(w.fielderId) ?? { catches: 0, runOuts: 0, stumpings: 0 };
    if (w.kind === 'caught') f.catches += 1;
    if (w.kind === 'runOut') f.runOuts += 1;
    if (w.kind === 'stumped') f.stumpings += 1;
    fielding.set(w.fielderId, f);
    get(w.fielderId).fielding += w.kind === 'caught' ? 8 : 10;
  }

  const winner = state.result?.winnerTeamId;
  for (const p of impact.values()) {
    p.total = Math.round((p.batting + p.bowling + p.fielding) * (winner && p.teamId === winner ? 1.1 : 1));
    p.batting = Math.round(p.batting);
    p.bowling = Math.round(p.bowling);
    p.fielding = Math.round(p.fielding);
  }
  const impacts = [...impact.values()].sort((a, b) => b.total - a.total);
  let bestFielder: MatchAwards['bestFielder'];
  for (const [playerId, f] of fielding) {
    const score = f.catches + f.runOuts * 1.25 + f.stumpings * 1.25;
    const cur = bestFielder ? bestFielder.catches + bestFielder.runOuts * 1.25 + bestFielder.stumpings * 1.25 : -1;
    if (score > cur) bestFielder = { playerId, teamId: teamOf.get(playerId) ?? '', ...f };
  }
  return { bestBatter, bestBowler, bestFielder, playerOfMatch: impacts[0], impacts };
}
