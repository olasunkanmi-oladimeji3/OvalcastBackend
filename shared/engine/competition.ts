// Competition maths: net run rate, points tables and fixture generation.

export interface InningsSummary {
  teamId: string;
  runs: number;
  /** Legal balls actually faced. */
  balls: number;
  wickets: number;
  allOut: boolean;
}

export interface ResultSummary {
  matchId: string;
  innings: [InningsSummary, InningsSummary];
  outcome: 'win' | 'tie' | 'noResult' | 'abandoned' | 'cancelled' | 'walkover' | 'doubleForfeit';
  winnerTeamId?: string;
  /** Full quota of balls per innings, used for the all-out rule. */
  quotaBalls: number;
  ballsPerOver: number;
}

export interface StandingRow {
  teamId: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  noResult: number;
  points: number;
  runsFor: number;
  oversFor: number;
  runsAgainst: number;
  oversAgainst: number;
  nrr: number;
  form: ('W' | 'L' | 'T' | 'N')[];
  /** Points taken off by the league for violations; already subtracted from `points`. */
  deducted: number;
}

export interface PointsSystem {
  win: number;
  tie: number;
  noResult: number;
  loss: number;
}

export type TieBreaker = 'wins' | 'nrr' | 'headToHead';

/**
 * Builds a points table. NRR follows the ICC rules in the PRD: a side bowled out
 * is charged its full quota of overs, and matches without a result are left out.
 */
export function standings(
  teamIds: string[],
  results: ResultSummary[],
  points: PointsSystem = { win: 2, tie: 1, noResult: 1, loss: 0 },
  tieBreakers: TieBreaker[] = ['wins', 'nrr', 'headToHead'],
  deductions: { teamId: string; points: number }[] = [],
): StandingRow[] {
  const rows = new Map<string, StandingRow>(
    teamIds.map((id) => [
      id,
      { teamId: id, played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0, nrr: 0, form: [], deducted: 0 },
    ]),
  );

  for (const r of results) {
    const [a, b] = r.innings;
    const ra = rows.get(a.teamId);
    const rb = rows.get(b.teamId);
    if (!ra || !rb) continue;
    ra.played += 1;
    rb.played += 1;
    // Walkovers and double forfeits: points only, nothing towards net run rate.
    if (r.outcome === 'walkover' || r.outcome === 'doubleForfeit') {
      const w = r.outcome === 'walkover' ? (r.winnerTeamId === a.teamId ? ra : rb) : undefined;
      for (const x of [ra, rb]) {
        if (x === w) {
          x.won += 1;
          x.points += points.win;
          x.form.push('W');
        } else {
          x.lost += 1;
          x.points += points.loss;
          x.form.push('L');
        }
      }
      continue;
    }
    if (r.outcome === 'noResult' || r.outcome === 'abandoned' || r.outcome === 'cancelled') {
      for (const x of [ra, rb]) {
        x.noResult += 1;
        x.points += points.noResult;
        x.form.push('N');
      }
      continue;
    }
    if (r.outcome === 'tie') {
      for (const x of [ra, rb]) {
        x.tied += 1;
        x.points += points.tie;
        x.form.push('T');
      }
    } else {
      const w = r.winnerTeamId === a.teamId ? ra : rb;
      const l = w === ra ? rb : ra;
      w.won += 1;
      w.points += points.win;
      w.form.push('W');
      l.lost += 1;
      l.points += points.loss;
      l.form.push('L');
    }
    const overs = (i: InningsSummary) => (i.allOut ? r.quotaBalls : i.balls) / r.ballsPerOver;
    ra.runsFor += a.runs;
    ra.oversFor += overs(a);
    ra.runsAgainst += b.runs;
    ra.oversAgainst += overs(b);
    rb.runsFor += b.runs;
    rb.oversFor += overs(b);
    rb.runsAgainst += a.runs;
    rb.oversAgainst += overs(a);
  }

  for (const d of deductions) {
    const row = rows.get(d.teamId);
    if (!row) continue;
    row.deducted += d.points;
    row.points -= d.points;
  }

  for (const row of rows.values()) {
    const forRate = row.oversFor > 0 ? row.runsFor / row.oversFor : 0;
    const againstRate = row.oversAgainst > 0 ? row.runsAgainst / row.oversAgainst : 0;
    row.nrr = Math.round((forRate - againstRate) * 1000) / 1000;
    row.form = row.form.slice(-5);
  }

  const headToHead = (x: string, y: string) => {
    const games = results.filter((r) => r.outcome === 'win' && r.innings.some((i) => i.teamId === x) && r.innings.some((i) => i.teamId === y));
    const xw = games.filter((g) => g.winnerTeamId === x).length;
    return games.length - xw - xw;
  };

  return [...rows.values()].sort((x, y) => {
    if (y.points !== x.points) return y.points - x.points;
    for (const t of tieBreakers) {
      if (t === 'wins' && y.won !== x.won) return y.won - x.won;
      if (t === 'nrr' && y.nrr !== x.nrr) return y.nrr - x.nrr;
      if (t === 'headToHead') {
        const h = headToHead(x.teamId, y.teamId);
        if (h !== 0) return h;
      }
    }
    return 0;
  });
}

/** Net run rate from a single team's perspective, for the calculator. */
export function netRunRate(
  rows: { runsFor: number; ballsFaced: number; allOut: boolean; runsAgainst: number; ballsBowled: number; oppAllOut: boolean }[],
  quotaBalls: number,
  ballsPerOver = 6,
): number {
  let rf = 0, of = 0, ra = 0, oa = 0;
  for (const r of rows) {
    rf += r.runsFor;
    of += (r.allOut ? quotaBalls : r.ballsFaced) / ballsPerOver;
    ra += r.runsAgainst;
    oa += (r.oppAllOut ? quotaBalls : r.ballsBowled) / ballsPerOver;
  }
  if (of === 0 || oa === 0) return 0;
  return rf / of - ra / oa;
}

/**
 * Round robin by the circle method. Odd team counts get a bye each round.
 * Returns rounds of [home, away] pairs, alternating home and away fairly.
 */
export function roundRobin(teamIds: string[], doubleRound = false): [string, string][][] {
  const teams = [...teamIds];
  if (teams.length % 2 === 1) teams.push('BYE');
  const n = teams.length;
  const rounds: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = teams[i];
      const b = teams[n - 1 - i];
      if (a === 'BYE' || b === 'BYE') continue;
      round.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(round);
    teams.splice(1, 0, teams.pop()!);
  }
  if (doubleRound) return [...rounds, ...rounds.map((rd) => rd.map(([h, a]) => [a, h] as [string, string]))];
  return rounds;
}

export interface BracketMatch {
  round: number; // 1 is the first round
  slot: number;
  roundName: string;
  home?: string;
  away?: string;
  /** Labels while a side is not known yet, such as "Winner of semi-final 1". */
  homeLabel?: string;
  awayLabel?: string;
  /** Where the winner goes. */
  next?: { round: number; slot: number; side: 'home' | 'away' };
  /** A bye: `home` goes straight through and no match is played. */
  bye?: boolean;
}

export function roundName(teamsInRound: number) {
  if (teamsInRound === 2) return 'Final';
  if (teamsInRound === 4) return 'Semi-final';
  if (teamsInRound === 8) return 'Quarter-final';
  return `Round of ${teamsInRound}`;
}

/** Seed positions so the top seeds meet as late as possible: 1, 8, 4, 5, 2, 7, 3, 6 for eight. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2;
    order = order.flatMap((s) => [s, m + 1 - s]);
  }
  return order;
}

/**
 * A single-elimination bracket from teams in seed order. Uneven numbers get
 * byes, given to the top seeds, who go straight into round two.
 */
export function buildBracket(seeds: string[]): BracketMatch[][] {
  if (seeds.length < 2) return [];
  let size = 2;
  while (size < seeds.length) size *= 2;
  const order = seedOrder(size).map((n) => seeds[n - 1]);
  const rounds: BracketMatch[][] = [];
  let teams = size;
  for (let r = 1; teams >= 2; r++, teams /= 2) {
    const name = roundName(teams);
    rounds.push(
      Array.from({ length: teams / 2 }, (_, slot) => ({
        round: r,
        slot,
        roundName: name,
        next: teams > 2 ? { round: r + 1, slot: Math.floor(slot / 2), side: slot % 2 === 0 ? 'home' : 'away' } : undefined,
      })),
    );
  }
  const label = (m: BracketMatch) => `Winner of ${m.roundName.toLowerCase()} ${m.slot + 1}`;
  rounds[0].forEach((m, i) => {
    m.home = order[i * 2];
    m.away = order[i * 2 + 1];
    if (!m.away || !m.home) {
      m.bye = true;
      m.home = m.home ?? m.away;
      m.away = undefined;
    }
  });
  // Fill later rounds: byes advance at once, everything else waits for a winner.
  for (let r = 0; r < rounds.length - 1; r++) {
    for (const m of rounds[r]) {
      const target = rounds[r + 1][m.next!.slot];
      if (m.bye) target[m.next!.side] = m.home;
      else target[m.next!.side === 'home' ? 'homeLabel' : 'awayLabel'] = label(m);
    }
  }
  return rounds;
}

/**
 * A finished match as the points table sees it, or undefined if it does not
 * count yet. Abandoned and no-result matches count without innings: a point
 * each, and nothing towards net run rate.
 */
export function tableResult(
  m: { id: string; homeTeamId: string; awayTeamId: string; status: string; scores: InningsSummary[]; result?: { outcome: ResultSummary['outcome']; winnerTeamId?: string } },
  quotaBalls: number,
  ballsPerOver: number,
): ResultSummary | undefined {
  if (m.status !== 'completed' && m.status !== 'abandoned') return undefined;
  if (!m.result) return undefined;
  const noResult = m.result.outcome === 'noResult' || m.result.outcome === 'abandoned' || m.result.outcome === 'cancelled' || m.result.outcome === 'walkover' || m.result.outcome === 'doubleForfeit';
  if (!noResult && m.scores.length !== 2) return undefined;
  const empty = (teamId: string): InningsSummary => ({ teamId, runs: 0, wickets: 0, balls: 0, allOut: false });
  const innings: [InningsSummary, InningsSummary] = m.scores.length === 2 ? [m.scores[0], m.scores[1]] : [empty(m.homeTeamId), empty(m.awayTeamId)];
  return { matchId: m.id, innings, outcome: m.result.outcome, winnerTeamId: m.result.winnerTeamId, quotaBalls, ballsPerOver };
}

/**
 * Fits a group stage to the teams that actually entered, before fixtures are built:
 * no more groups than leaves at least three teams in each (or one group for a
 * handful), teams dealt in turn so groups stay even, and fewer qualifying than play.
 * With a single group, the top two go through so there is still a final.
 */
export function fitGroups<G extends { id: string; teamIds: string[] }>(stage: { groups: G[]; qualify?: { topPerGroup: number } }, teamIds: string[]) {
  const n = teamIds.length;
  const count = Math.max(1, Math.min(stage.groups.length, Math.floor(n / 3) || 1));
  const groups = stage.groups.slice(0, count).map((g) => ({ ...g, teamIds: [] as string[] }));
  teamIds.forEach((t, i) => groups[i % count]!.teamIds.push(t));
  stage.groups = groups;
  if (stage.qualify) {
    const smallest = Math.min(...groups.map((g) => g.teamIds.length));
    stage.qualify.topPerGroup = count === 1 ? Math.min(Math.max(2, stage.qualify.topPerGroup), smallest) : Math.max(1, Math.min(stage.qualify.topPerGroup, smallest - 1));
  }
}
