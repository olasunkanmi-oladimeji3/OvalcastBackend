// The milestone chase: first-time milestones and career ladders, worked out
// from a player's matches in order. Only official matches count (locked,
// in a competition); leather-ball and tennis-ball records are kept apart.

import { activeEvents } from './engine';
import type { BallEvent, MatchState } from './types';

export interface MilestoneMatchLine {
  matchId: string;
  date: string;
  ballType: 'leather' | 'tennis';
  runs?: number;
  balls?: number;
  out?: boolean;
  fours?: number;
  sixes?: number;
  wickets?: number;
  maidens?: number;
  hatTrick?: boolean;
  catches?: number;
  stumpings?: number;
  runOuts?: number;
  captain?: boolean;
  playerOfMatch?: boolean;
  /** An unbeaten fifty while chasing, in a match the side won. */
  unbeatenFiftyInWinningChase?: boolean;
}

export interface Milestone {
  id: string;
  category: 'batting' | 'bowling' | 'fielding' | 'matches';
  label: string;
  ballType: 'leather' | 'tennis';
  /** Set once earned. */
  matchId?: string;
  date?: string;
  /** In progress: how far along, for "12 runs to your first 50". */
  progress?: { current: number; target: number; unit: string };
}

type Counter = (l: MilestoneMatchLine) => number;
interface Ladder {
  id: string;
  category: Milestone['category'];
  unit: string;
  steps: number[];
  count: Counter;
  label: (n: number) => string;
}
interface First {
  id: string;
  category: Milestone['category'];
  label: string;
  hit: (l: MilestoneMatchLine) => boolean;
  /** For progress toward a single-innings milestone, such as a first 50. */
  best?: { value: Counter; target: number; unit: string };
}

const dismissals: Counter = (l) => (l.catches ?? 0) + (l.stumpings ?? 0) + (l.runOuts ?? 0);

const FIRSTS: First[] = [
  { id: 'first-run', category: 'batting', label: 'First run', hit: (l) => (l.runs ?? 0) >= 1 },
  { id: 'first-boundary', category: 'batting', label: 'First boundary', hit: (l) => (l.fours ?? 0) + (l.sixes ?? 0) >= 1 },
  { id: 'first-six', category: 'batting', label: 'First six', hit: (l) => (l.sixes ?? 0) >= 1 },
  { id: 'first-25', category: 'batting', label: 'First 25', hit: (l) => (l.runs ?? 0) >= 25, best: { value: (l) => l.runs ?? 0, target: 25, unit: 'runs' } },
  { id: 'first-50', category: 'batting', label: 'First 50', hit: (l) => (l.runs ?? 0) >= 50, best: { value: (l) => l.runs ?? 0, target: 50, unit: 'runs' } },
  { id: 'first-100', category: 'batting', label: 'First 100', hit: (l) => (l.runs ?? 0) >= 100, best: { value: (l) => l.runs ?? 0, target: 100, unit: 'runs' } },
  { id: 'first-unbeaten-50-chase', category: 'batting', label: 'First unbeaten 50 in a winning chase', hit: (l) => !!l.unbeatenFiftyInWinningChase },
  { id: 'first-wicket', category: 'bowling', label: 'First wicket', hit: (l) => (l.wickets ?? 0) >= 1 },
  { id: 'first-maiden', category: 'bowling', label: 'First maiden', hit: (l) => (l.maidens ?? 0) >= 1 },
  { id: 'first-3fer', category: 'bowling', label: 'First 3-wicket haul', hit: (l) => (l.wickets ?? 0) >= 3, best: { value: (l) => l.wickets ?? 0, target: 3, unit: 'wickets' } },
  { id: 'first-5fer', category: 'bowling', label: 'First 5-wicket haul', hit: (l) => (l.wickets ?? 0) >= 5, best: { value: (l) => l.wickets ?? 0, target: 5, unit: 'wickets' } },
  { id: 'first-hat-trick', category: 'bowling', label: 'First hat-trick', hit: (l) => !!l.hatTrick },
  { id: 'first-catch', category: 'fielding', label: 'First catch', hit: (l) => (l.catches ?? 0) >= 1 },
  { id: 'first-stumping', category: 'fielding', label: 'First stumping', hit: (l) => (l.stumpings ?? 0) >= 1 },
  { id: 'first-run-out', category: 'fielding', label: 'First run out', hit: (l) => (l.runOuts ?? 0) >= 1 },
  { id: 'first-match', category: 'matches', label: 'First match', hit: () => true },
  { id: 'first-captain', category: 'matches', label: 'First match as captain', hit: (l) => !!l.captain },
  { id: 'first-potm', category: 'matches', label: 'First player of the match award', hit: (l) => !!l.playerOfMatch },
];

const LADDERS: Ladder[] = [
  { id: 'runs', category: 'batting', unit: 'runs', steps: [100, 250, 500, 1000, 2500, 5000], count: (l) => l.runs ?? 0, label: (n) => `${n.toLocaleString('en-GB')} career runs` },
  { id: 'sixes', category: 'batting', unit: 'sixes', steps: [10, 50, 100], count: (l) => l.sixes ?? 0, label: (n) => `${n} career sixes` },
  { id: 'wickets', category: 'bowling', unit: 'wickets', steps: [10, 25, 50, 100, 200], count: (l) => l.wickets ?? 0, label: (n) => `${n} career wickets` },
  { id: 'dismissals', category: 'fielding', unit: 'dismissals', steps: [10, 25, 50], count: dismissals, label: (n) => `${n} catches, stumpings and run outs` },
  { id: 'matches', category: 'matches', unit: 'matches', steps: [10, 25, 50, 100], count: () => 1, label: (n) => `${n} matches` },
];

/** Every milestone earned, newest first, and the next few in progress for each ball type. */
export function milestoneChase(lines: MilestoneMatchLine[], inProgress = 4): { earned: Milestone[]; next: Milestone[] } {
  const earned: Milestone[] = [];
  const next: Milestone[] = [];
  for (const ballType of ['leather', 'tennis'] as const) {
    const mine = lines.filter((l) => l.ballType === ballType).sort((a, b) => a.date.localeCompare(b.date));
    if (!mine.length) continue;
    for (const f of FIRSTS) {
      const hit = mine.find(f.hit);
      if (hit) earned.push({ id: `${ballType}:${f.id}`, category: f.category, label: f.label, ballType, matchId: hit.matchId, date: hit.date });
      else if (f.best) {
        const best = Math.max(0, ...mine.map(f.best.value));
        if (best > 0) next.push({ id: `${ballType}:${f.id}`, category: f.category, label: f.label, ballType, progress: { current: best, target: f.best.target, unit: f.best.unit } });
      }
    }
    for (const lad of LADDERS) {
      let total = 0;
      let step = 0;
      for (const l of mine) {
        total += lad.count(l);
        while (step < lad.steps.length && total >= lad.steps[step]) {
          earned.push({ id: `${ballType}:${lad.id}-${lad.steps[step]}`, category: lad.category, label: lad.label(lad.steps[step]), ballType, matchId: l.matchId, date: l.date });
          step += 1;
        }
      }
      if (step < lad.steps.length && total > 0) next.push({ id: `${ballType}:${lad.id}-${lad.steps[step]}`, category: lad.category, label: lad.label(lad.steps[step]), ballType, progress: { current: total, target: lad.steps[step], unit: lad.unit } });
    }
  }
  earned.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  // Closest to done first.
  next.sort((a, b) => b.progress!.current / b.progress!.target - a.progress!.current / a.progress!.target);
  return { earned, next: next.slice(0, inProgress * 2) };
}

/** "12 runs to your first 50". */
export const milestoneHint = (m: Milestone) => (m.progress ? `${m.progress.target - m.progress.current} ${m.progress.unit} to ${m.label.charAt(0).toLowerCase()}${m.label.slice(1)}` : m.label);

/**
 * One player's milestone lines from replayed matches. Only official matches
 * count: locked, or completed in a competition. Friendlies never do.
 */
export function milestoneLines(
  playerIds: string[],
  replays: { match: { id: string; startsAt: string; competitionId?: string; friendly?: boolean; status: string; locked: boolean }; ballType: 'leather' | 'tennis'; state: MatchState; events: BallEvent[] }[],
): MilestoneMatchLine[] {
  const ids = new Set(playerIds);
  const out: MilestoneMatchLine[] = [];
  for (const r of replays) {
    if (r.match.friendly || !r.match.competitionId || r.match.status !== 'completed') continue;
    const line: MilestoneMatchLine = { matchId: r.match.id, date: r.match.startsAt, ballType: r.ballType };
    let played = false;
    r.state.innings.forEach((inn, i) => {
      for (const b of inn.batters) {
        if (!ids.has(b.playerId)) continue;
        played = true;
        Object.assign(line, { runs: (line.runs ?? 0) + b.runs, balls: (line.balls ?? 0) + b.balls, fours: (line.fours ?? 0) + b.fours, sixes: (line.sixes ?? 0) + b.sixes, out: !!b.out });
        const won = r.state.result?.winnerTeamId === inn.battingTeamId;
        if (i === 1 && !b.out && b.runs >= 50 && won) line.unbeatenFiftyInWinningChase = true;
      }
      for (const b of inn.bowlers) {
        if (!ids.has(b.playerId)) continue;
        played = true;
        line.wickets = (line.wickets ?? 0) + b.wickets;
        line.maidens = (line.maidens ?? 0) + b.maidens;
      }
    });
    // Fielding, and hat-tricks: three of the bowler's wickets from consecutive deliveries.
    const streak = new Map<string, number>();
    for (const e of activeEvents(r.events)) {
      const w = e.wicket;
      if (w?.fielderId && ids.has(w.fielderId)) {
        played = true;
        if (w.kind === 'caught') line.catches = (line.catches ?? 0) + 1;
        if (w.kind === 'stumped') line.stumpings = (line.stumpings ?? 0) + 1;
        if (w.kind === 'runOut') line.runOuts = (line.runOuts ?? 0) + 1;
      }
      const toBowler = !!w && !['runOut', 'retiredHurt', 'retiredOut', 'timedOut', 'obstructing'].includes(w.kind);
      const n = toBowler ? (streak.get(e.bowlerId) ?? 0) + 1 : 0;
      streak.set(e.bowlerId, n);
      if (n >= 3 && ids.has(e.bowlerId)) line.hatTrick = true;
    }
    if (played) out.push(line);
  }
  return out;
}
