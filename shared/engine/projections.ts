// Projected scores and win chance (PRD: "Toss, calculators, projected score").
// The wicket-aware model is Ovalcast's own demo curve, not WASP or DLS; it is
// replaced by a model calibrated on real match data before launch.

import type { InningsState, PlayingConditions } from './types';

/** Expected further runs with `oversLeft` overs and `wicketsLost` down. */
export function expectedRuns(oversLeft: number, wicketsLost: number): number {
  if (oversLeft <= 0 || wicketsLost >= 10) return 0;
  const inHand = (10 - wicketsLost) / 10;
  // Calibrated to typical T20 benchmarks: about 150 from 20 overs with no
  // wickets down, about 70 from 10 overs with 5 down.
  const ceiling = 300 * Math.pow(inHand, 0.8);
  const rate = 0.035 / Math.sqrt(inHand);
  return ceiling * (1 - Math.exp(-rate * oversLeft));
}

export interface Projection {
  atCurrentRate: number;
  atRates: { rate: number; total: number }[];
  wicketAware: number;
}

export function projectFirstInnings(s: InningsState, c: PlayingConditions): Projection {
  const bpo = c.ballsPerOver;
  const ballsLeft = s.maxOvers * bpo - s.legalBalls;
  const oversLeft = ballsLeft / bpo;
  const crr = s.legalBalls > 0 ? (s.runs / s.legalBalls) * bpo : 0;
  return {
    atCurrentRate: Math.round(s.runs + crr * oversLeft),
    atRates: [6, 8, 10, 12].map((rate) => ({ rate, total: Math.round(s.runs + rate * oversLeft) })),
    wicketAware: Math.round(s.runs + expectedRuns(oversLeft, s.wickets) * (c.oversPerInnings / 20) ** 0.15),
  };
}

export interface ChaseState {
  runsNeeded: number;
  ballsLeft: number;
  requiredRate: number;
  currentRate: number;
  winChance: number; // 0..1 for the chasing side
  reason: string;
}

export function chaseState(s: InningsState, c: PlayingConditions): ChaseState | undefined {
  if (s.target === undefined) return undefined;
  const bpo = c.ballsPerOver;
  const ballsLeft = Math.max(0, s.maxOvers * bpo - s.legalBalls);
  const runsNeeded = Math.max(0, s.target - s.runs);
  const requiredRate = ballsLeft > 0 ? (runsNeeded / ballsLeft) * bpo : Infinity;
  const currentRate = s.legalBalls > 0 ? (s.runs / s.legalBalls) * bpo : 0;
  const wicketsLeft = 10 - s.wickets;

  let winChance: number;
  if (runsNeeded === 0) winChance = 1;
  else if (ballsLeft === 0 || wicketsLeft <= 0) winChance = 0;
  else {
    const expected = expectedRuns(ballsLeft / bpo, s.wickets);
    const spread = 6 + 0.18 * runsNeeded;
    winChance = 1 / (1 + Math.exp((-1.7 * (expected - runsNeeded)) / spread));
  }

  const rr = Number.isFinite(requiredRate) ? requiredRate.toFixed(1) : '—';
  const reason =
    runsNeeded === 0
      ? 'Target reached'
      : `Needs ${rr} an over with ${wicketsLeft} wicket${wicketsLeft === 1 ? '' : 's'} left`;
  return { runsNeeded, ballsLeft, requiredRate, currentRate, winChance, reason };
}
