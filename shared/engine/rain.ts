// Rain, bad light or a late start: how many overs each side gets, and what
// the side batting second needs. Follows the shape of the ICC's playing
// conditions: lost time comes off at the over rate (14.11 overs an hour in
// T20, 14.28 in 50-over cricket), fractions of an over are dropped, both sides
// lose overs equally until the second innings starts, and only the second
// side loses overs after that. Below the minimum overs a side, there's no result.
//
// Revised targets use a method grassroots leagues can check by hand. DLS is
// the professional standard but its resource tables are licensed by the ICC,
// so it isn't offered until Ovalcast has that licence.

import type { InningsState, MatchState } from './types';

export type RainRule = 'arr' | 'mpo';

export const RAIN_RULES: { value: RainRule; label: string; sub: string }[] = [
  { value: 'arr', label: 'Average run rate', sub: 'The target scales with the overs the chasing side gets. Simple to check by hand.' },
  { value: 'mpo', label: 'Most productive overs', sub: 'The target is the runs from the first side’s best overs, as many as the chase has.' },
];

/** Overs an hour used to turn lost time into lost overs. */
export const oversPerHour = (oversPerInnings: number) => (oversPerInnings > 20 ? 14.28 : 14.11);

/** The fewest overs a side must be able to face for there to be a result. */
export function minimumOvers(oversPerInnings: number): number {
  if (oversPerInnings <= 10) return Math.min(oversPerInnings, Math.ceil(oversPerInnings / 2));
  if (oversPerInnings <= 20) return 5;
  return Math.ceil(oversPerInnings * 0.4);
}

export interface Reduction {
  /** Overs each side can face. */
  overs: [number, number];
  /** Overs taken off the match by this stoppage. */
  oversLost: number;
  /** Too few overs are left for a result. */
  noResult: boolean;
}

/**
 * Overs each side gets after a stoppage of `minutesLost` (after any extra time
 * the playing conditions allow). `current` is the overs each side had before it.
 */
export function reduceOvers(input: {
  oversPerInnings: number;
  current: [number, number];
  minutesLost: number;
  /** 1 while the first innings is on (or before the start); 2 once the chase has started. */
  innings: 1 | 2;
  /** Legal balls already bowled in the innings in play, so it can't be cut below them. */
  ballsBowled: number;
  ballsPerOver: number;
}): Reduction {
  const lost = Math.floor((Math.max(0, input.minutesLost) / 60) * oversPerHour(input.oversPerInnings));
  const done = Math.ceil(input.ballsBowled / input.ballsPerOver);
  let [a, b] = input.current;
  if (input.innings === 1) {
    // Both sides lose overs equally; the first innings can't drop below what's been bowled.
    const each = Math.ceil(lost / 2);
    a = Math.max(done, a - each);
    b = Math.max(1, b - each);
  } else {
    b = Math.max(done, b - lost);
  }
  const min = minimumOvers(input.oversPerInnings);
  return { overs: [a, b], oversLost: lost, noResult: b < min || (input.innings === 1 && a < min && a < input.current[0]) };
}

/**
 * What the side batting second needs, off `oversForChase`, after the first side
 * made `first.runs` with `oversForFirst` overs available to them.
 */
export function revisedTarget(rule: RainRule, first: InningsState, oversForFirst: number, oversForChase: number): number {
  if (oversForChase >= oversForFirst) return first.runs + 1;
  if (rule === 'mpo') {
    const best = [...first.overs].map((o) => o.runs).sort((x, y) => y - x).slice(0, oversForChase);
    return best.reduce((s, r) => s + r, 0) + 1;
  }
  return Math.floor((first.runs * oversForChase) / oversForFirst) + 1;
}

/** One line for the scorecard and the result: "Reduced to 14 overs a side by rain. Target 112 (average run rate)." */
export function reductionText(overs: [number, number], target: number | undefined, rule: RainRule, reason = 'rain'): string {
  const sides = overs[0] === overs[1] ? `${overs[0]} overs a side` : `${overs[0]} overs, then ${overs[1]} for the chase`;
  const method = RAIN_RULES.find((r) => r.value === rule)?.label.toLowerCase();
  return `Reduced to ${sides} by ${reason}.${target ? ` Target ${target} (${method}).` : ''}`;
}

/**
 * A stoppage, from what the scorer or organiser reports: minutes lost on top of
 * any earlier stoppages, worked into overs for each side and, once the chase is
 * on or set, its target. The same on the phone and the server.
 */
export function applyStoppage(input: {
  oversPerInnings: number;
  ballsPerOver: number;
  rule: RainRule;
  previous?: { overs: [number, number]; minutesLost: number };
  minutesLost: number;
  reason: 'rain' | 'badLight' | 'lateStart' | 'other';
  state?: MatchState;
}) {
  const first = input.state?.innings[0];
  const inChase = !!first?.complete;
  const r = reduceOvers({
    oversPerInnings: input.oversPerInnings,
    current: input.previous?.overs ?? [input.oversPerInnings, input.oversPerInnings],
    minutesLost: input.minutesLost,
    innings: inChase ? 2 : 1,
    ballsBowled: (inChase ? input.state?.innings[1]?.legalBalls : first?.legalBalls) ?? 0,
    ballsPerOver: input.ballsPerOver,
  });
  const firstOvers = inChase ? first!.maxOvers : r.overs[0];
  const target = inChase && r.overs[1] < firstOvers ? revisedTarget(input.rule, first!, firstOvers, r.overs[1]) : undefined;
  const why = { rain: 'rain', badLight: 'bad light', lateStart: 'a late start', other: 'a stoppage' }[input.reason];
  return {
    overs: r.overs,
    target,
    noResult: r.noResult,
    minutesLost: (input.previous?.minutesLost ?? 0) + input.minutesLost,
    text: r.noResult ? `Too few overs left after ${why}: no result.` : reductionText(r.overs, target, input.rule, why),
  };
}
