import { revisedTarget } from './rain';
// Replays ball events into a full match state. Totals are never stored: every
// scorecard, chart and projection is calculated from the event log, so undo,
// edits, offline sync and audits always agree with a fresh replay.

import type {
  BallChip,
  BallEvent,
  BatterLine,
  BowlerLine,
  DismissalKind,
  InningsState,
  MatchResult,
  MatchSetup,
  MatchState,
} from './types';

const BOWLER_CREDITED: DismissalKind[] = ['bowled', 'caught', 'lbw', 'stumped', 'hitWicket'];

export const formatOvers = (legalBalls: number, ballsPerOver = 6) =>
  `${Math.floor(legalBalls / ballsPerOver)}.${legalBalls % ballsPerOver}`;

export const isLegal = (e: BallEvent) =>
  !e.extra || (e.extra.kind !== 'wide' && e.extra.kind !== 'noBall' && e.extra.kind !== 'penalty');

/** Drops voided events and sorts the rest into playing order. */
export function activeEvents(events: BallEvent[]): BallEvent[] {
  // A void cancels the ball it names; neither counts. Everything that reads balls (the score,
  // stats, commentary, undo) works from what's left. A void made offline names the ball by the
  // phone's id for it (its clientId), which stays true after the server gives it its own id.
  const voided = new Set(events.filter((e) => e.kind === 'void' && e.voidOf).map((e) => e.voidOf));
  return events
    .filter((e) => e.kind !== 'void' && !voided.has(e.id) && !voided.has(e.clientId))
    .sort((a, b) => a.innings - b.innings || a.seq - b.seq || a.createdAt.localeCompare(b.createdAt));
}

/** Total runs a delivery adds to the team score. */
export function deliveryRuns(e: BallEvent, setup: MatchSetup): number {
  const c = setup.conditions;
  if (!e.extra) return e.bat;
  switch (e.extra.kind) {
    case 'wide':
      return c.wideRuns + e.extra.runs;
    case 'noBall':
      return c.noBallRuns + e.bat + e.extra.runs;
    default:
      return e.bat + e.extra.runs;
  }
}

export function chipFor(e: BallEvent, setup: MatchSetup): BallChip {
  const runs = deliveryRuns(e, setup);
  if (e.wicket && e.wicket.kind !== 'retiredHurt') {
    return { eventId: e.id, label: runs > 0 ? `W+${runs}` : 'W', tone: 'wicket' };
  }
  if (e.extra) {
    const k = e.extra.kind;
    const extraRuns = k === 'noBall' ? e.bat + e.extra.runs : e.extra.runs;
    const tag = { wide: 'wd', noBall: 'nb', bye: 'b', legBye: 'lb', penalty: 'pen' }[k];
    return { eventId: e.id, label: extraRuns > 0 ? `${tag}${k === 'noBall' ? '+' : ''}${extraRuns}` : tag, tone: 'extra' };
  }
  if (e.bat === 6 && e.boundary) return { eventId: e.id, label: '6', tone: 'six' };
  if (e.bat === 4 && e.boundary) return { eventId: e.id, label: '4', tone: 'four' };
  if (e.bat === 0) return { eventId: e.id, label: '•', tone: 'dot' };
  return { eventId: e.id, label: String(e.bat), tone: 'run' };
}

function dismissalText(kind: DismissalKind, bowler: string, fielder?: string): string {
  switch (kind) {
    case 'bowled':
      return `b ${bowler}`;
    case 'caught':
      return fielder === bowler || !fielder ? `c & b ${bowler}` : `c ${fielder} b ${bowler}`;
    case 'lbw':
      return `lbw b ${bowler}`;
    case 'stumped':
      return `st ${fielder ?? '?'} b ${bowler}`;
    case 'runOut':
      return fielder ? `run out (${fielder})` : 'run out';
    case 'hitWicket':
      return `hit wicket b ${bowler}`;
    case 'obstructing':
      return 'obstructing the field';
    case 'hitTwice':
      return 'hit the ball twice';
    case 'timedOut':
      return 'timed out';
    case 'retiredOut':
      return 'retired out';
    case 'retiredHurt':
      return 'retired hurt';
  }
}

function newInnings(n: number, battingTeamId: string, bowlingTeamId: string, maxOvers: number): InningsState {
  return {
    maxOvers,
    number: n,
    battingTeamId,
    bowlingTeamId,
    runs: 0,
    wickets: 0,
    legalBalls: 0,
    extras: { wide: 0, noBall: 0, bye: 0, legBye: 0, penalty: 0 },
    batters: [],
    bowlers: [],
    fallOfWickets: [],
    partnerships: [],
    overs: [],
    freeHitNext: false,
    complete: false,
    shots: [],
  };
}

export function replay(setup: MatchSetup, events: BallEvent[]): MatchState {
  const c = setup.conditions;
  const [t1, t2] = setup.teams;
  const first = setup.battingFirstTeamId === t1.id ? t1 : t2;
  const second = first === t1 ? t2 : t1;
  const nameOf = new Map<string, string>();
  for (const t of setup.teams) for (const p of t.players) nameOf.set(p.id, p.shortName);
  const squadSize = (teamId: string) => setup.teams.find((t) => t.id === teamId)!.players.length;

  // Rain or a late start can cut each side's overs and revise the chase's target.
  const oversFor = (n: number) => setup.reduced?.overs[n - 1] ?? c.oversPerInnings;
  const targetAfter = (first: InningsState) =>
    setup.reduced?.target ?? (setup.reduced && setup.reduced.overs[1] < first.maxOvers ? revisedTarget(setup.reduced.rule, first, first.maxOvers, setup.reduced.overs[1]) : first.runs + 1);
  const inns: InningsState[] = [newInnings(1, first.id, second.id, oversFor(1))];
  let partnership = { runs: 0, balls: 0 };

  const batter = (s: InningsState, id: string): BatterLine => {
    let b = s.batters.find((x) => x.playerId === id);
    if (!b) {
      b = { playerId: id, runs: 0, balls: 0, fours: 0, sixes: 0, order: s.batters.length + 1 };
      s.batters.push(b);
    }
    return b;
  };
  const bowler = (s: InningsState, id: string): BowlerLine => {
    let b = s.bowlers.find((x) => x.playerId === id);
    if (!b) {
      b = { playerId: id, balls: 0, runs: 0, wickets: 0, maidens: 0, wides: 0, noBalls: 0, dots: 0 };
      s.bowlers.push(b);
    }
    return b;
  };

  for (const e of activeEvents(events)) {
    while (inns.length < e.innings) {
      const prev = inns[inns.length - 1];
      prev.complete = true;
      const next = newInnings(inns.length + 1, prev.bowlingTeamId, prev.battingTeamId, oversFor(inns.length + 1));
      next.target = targetAfter(prev);
      inns.push(next);
      partnership = { runs: 0, balls: 0 };
    }
    const s = inns[e.innings - 1];
    const legal = isLegal(e);
    const runs = deliveryRuns(e, setup);
    const kind = e.extra?.kind;

    // Batters at the crease come from the event, so a mid-innings correction
    // (wrong striker, retired batter) is fixed by the next ball's data.
    s.strikerId = e.strikerId;
    s.nonStrikerId = e.nonStrikerId;
    s.bowlerId = e.bowlerId;
    const striker = batter(s, e.strikerId);
    batter(s, e.nonStrikerId);
    const bw = bowler(s, e.bowlerId);

    // Team total and extras.
    s.runs += runs;
    if (kind === 'wide') s.extras.wide += runs;
    if (kind === 'noBall') {
      s.extras.noBall += c.noBallRuns;
      if (e.extra!.nbVia === 'bye') s.extras.bye += e.extra!.runs;
      if (e.extra!.nbVia === 'legBye') s.extras.legBye += e.extra!.runs;
    }
    if (kind === 'bye') s.extras.bye += e.extra!.runs;
    if (kind === 'legBye') s.extras.legBye += e.extra!.runs;
    if (kind === 'penalty') s.extras.penalty += e.extra!.runs;

    // Batter: every ball except a wide counts as faced.
    if (kind !== 'wide' && kind !== 'penalty') striker.balls += 1;
    striker.runs += e.bat;
    if (e.boundary && e.bat === 4) striker.fours += 1;
    if (e.boundary && e.bat === 6) striker.sixes += 1;
    if (e.shot && e.bat > 0) s.shots.push({ batterId: e.strikerId, runs: e.bat, shot: e.shot });

    // Bowler: byes, leg byes and penalties are not charged to the bowler.
    let conceded = 0;
    if (kind === 'wide') {
      conceded = runs;
      bw.wides += 1;
    } else if (kind === 'noBall') {
      conceded = c.noBallRuns + e.bat + (e.extra!.nbVia === 'bat' || !e.extra!.nbVia ? e.extra!.runs : 0);
      bw.noBalls += 1;
    } else if (!kind) {
      conceded = e.bat;
    }
    bw.runs += conceded;
    if (legal) {
      bw.balls += 1;
      if (runs === 0) bw.dots += 1;
      s.legalBalls += 1;
    }

    // Over summary.
    const overNo = Math.floor((s.legalBalls - (legal ? 1 : 0)) / c.ballsPerOver) + 1;
    let over = s.overs[s.overs.length - 1];
    if (!over || over.number !== overNo) {
      over = { number: overNo, bowlerId: e.bowlerId, runs: 0, wickets: 0, bowlerConceded: 0, chips: [] };
      s.overs.push(over);
    }
    over.runs += runs;
    over.bowlerConceded += conceded;
    over.chips.push(chipFor(e, setup));

    partnership.runs += runs;
    if (kind !== 'wide') partnership.balls += 1;

    // Strike rotates on odd runs actually run (boundaries are not run).
    let strikerId = e.strikerId;
    let nonStrikerId = e.nonStrikerId;
    const ran = e.boundary ? 0 : (kind === 'wide' || kind === 'bye' || kind === 'legBye' ? e.extra!.runs : e.bat + (kind === 'noBall' ? e.extra!.runs : 0));
    if (ran % 2 === 1) [strikerId, nonStrikerId] = [nonStrikerId, strikerId];

    // Wicket.
    if (e.wicket) {
      const w = e.wicket;
      const out = batter(s, w.playerOutId);
      const bowlerName = nameOf.get(e.bowlerId) ?? '';
      const fielderName = w.fielderId ? nameOf.get(w.fielderId) : undefined;
      out.out = { kind: w.kind, text: dismissalText(w.kind, bowlerName, fielderName) };
      if (w.kind !== 'retiredHurt') {
        s.wickets += 1;
        over.wickets += 1;
        s.fallOfWickets.push({ wicket: s.wickets, runs: s.runs, playerId: w.playerOutId, over: formatOvers(s.legalBalls, c.ballsPerOver) });
        s.partnerships.push({ wicket: s.wickets, runs: partnership.runs, balls: partnership.balls, batterIds: [e.strikerId, e.nonStrikerId] });
        partnership = { runs: 0, balls: 0 };
      }
      if (BOWLER_CREDITED.includes(w.kind)) bw.wickets += 1;
      const survivor = w.playerOutId === strikerId ? nonStrikerId : strikerId;
      if (w.kind === 'caught' && e.newBatterId) {
        // Since 2022 the new batter takes strike after a catch.
        strikerId = e.newBatterId;
        nonStrikerId = survivor;
      } else if (e.newBatterId) {
        if (w.playerOutId === strikerId) strikerId = e.newBatterId;
        else nonStrikerId = e.newBatterId;
      }
      if (e.newBatterId) batter(s, e.newBatterId);
    }

    s.freeHitNext = c.freeHit && (kind === 'noBall' || (s.freeHitNext && kind === 'wide'));

    // End of over: change ends and record a maiden.
    const overDone = legal && s.legalBalls % c.ballsPerOver === 0;
    if (overDone) {
      [strikerId, nonStrikerId] = [nonStrikerId, strikerId];
      if (over.bowlerConceded === 0) bw.maidens += 1;
      s.lastOverBowlerId = e.bowlerId;
      s.bowlerId = undefined;
    }
    s.strikerId = strikerId;
    s.nonStrikerId = nonStrikerId;

    const allOut = s.wickets >= squadSize(s.battingTeamId) - 1;
    const oversUp = s.legalBalls >= s.maxOvers * c.ballsPerOver;
    const chased = s.target !== undefined && s.runs >= s.target;
    if (allOut || oversUp || chased) s.complete = true;
    if (e.wicket && !e.newBatterId) {
      if (e.wicket.playerOutId === s.strikerId) s.strikerId = undefined;
      if (e.wicket.playerOutId === s.nonStrikerId) s.nonStrikerId = undefined;
    }
  }

  // Close the open partnership for display.
  const cur = inns[inns.length - 1];
  if (cur.strikerId && cur.nonStrikerId && (partnership.runs > 0 || partnership.balls > 0)) {
    cur.partnerships.push({ wicket: cur.wickets + 1, runs: partnership.runs, balls: partnership.balls, batterIds: [cur.strikerId, cur.nonStrikerId] });
  }

  // A completed first innings opens the second with a target.
  if (inns.length === 1 && inns[0].complete) {
    const next = newInnings(2, inns[0].bowlingTeamId, inns[0].battingTeamId, oversFor(2));
    next.target = targetAfter(inns[0]);
    inns.push(next);
  }
  // Overs cut after an innings got going: it ends where the new limit falls.
  for (const s of inns) if (!s.complete && s.legalBalls >= s.maxOvers * c.ballsPerOver && s.legalBalls > 0) s.complete = true;
  if (inns.length === 1 && inns[0].complete) {
    const next = newInnings(2, inns[0].bowlingTeamId, inns[0].battingTeamId, oversFor(2));
    next.target = targetAfter(inns[0]);
    inns.push(next);
  }

  const state: MatchState = { innings: inns, current: inns.find((i) => !i.complete) };
  if (inns.length === 2 && inns[1].complete) state.result = resultOf(setup, inns[0], inns[1]);
  return state;
}

function resultOf(setup: MatchSetup, a: InningsState, b: InningsState): MatchResult {
  const name = (id: string) => setup.teams.find((t) => t.id === id)!.name;
  // A revised target decides it: the chase wins by reaching it, or loses by the runs it fell short of the par.
  if (setup.reduced && b.target !== undefined && b.target !== a.runs + 1) {
    const t = b.target;
    const how = setup.reduced.rule === 'mpo' ? 'most productive overs' : 'average run rate';
    if (b.runs >= t) {
      const left = setup.teams.find((x) => x.id === b.battingTeamId)!.players.length - 1 - b.wickets;
      return { kind: 'wickets', winnerTeamId: b.battingTeamId, margin: left, text: `${name(b.battingTeamId)} won by ${left} wicket${left === 1 ? '' : 's'} (${how})` };
    }
    if (b.runs === t - 1) return { kind: 'tie', text: `Match tied (${how})` };
    const m = t - 1 - b.runs;
    return { kind: 'runs', winnerTeamId: a.battingTeamId, margin: m, text: `${name(a.battingTeamId)} won by ${m} run${m === 1 ? '' : 's'} (${how})` };
  }
  if (b.runs > a.runs) {
    const left = setup.teams.find((t) => t.id === b.battingTeamId)!.players.length - 1 - b.wickets;
    return { kind: 'wickets', winnerTeamId: b.battingTeamId, margin: left, text: `${name(b.battingTeamId)} won by ${left} wicket${left === 1 ? '' : 's'}` };
  }
  if (a.runs > b.runs) {
    const m = a.runs - b.runs;
    return { kind: 'runs', winnerTeamId: a.battingTeamId, margin: m, text: `${name(a.battingTeamId)} won by ${m} run${m === 1 ? '' : 's'}` };
  }
  return { kind: 'tie', text: 'Match tied' };
}

/** Players who may bowl the next over: not the last over's bowler, not at their limit. */
export function eligibleBowlers(setup: MatchSetup, s: InningsState): { id: string; reason?: string }[] {
  const team = setup.teams.find((t) => t.id === s.bowlingTeamId)!;
  const limit = setup.conditions.maxOversPerBowler * setup.conditions.ballsPerOver;
  return team.players.map((p) => {
    const line = s.bowlers.find((b) => b.playerId === p.id);
    if (p.id === s.lastOverBowlerId) return { id: p.id, reason: 'Bowled the last over' };
    if (line && line.balls >= limit) return { id: p.id, reason: 'At the over limit' };
    return { id: p.id };
  });
}

/** Batters who have not batted yet. */
export function yetToBat(setup: MatchSetup, s: InningsState): string[] {
  const team = setup.teams.find((t) => t.id === s.battingTeamId)!;
  const batted = new Set(s.batters.map((b) => b.playerId));
  return team.players.map((p) => p.id).filter((id) => !batted.has(id));
}
