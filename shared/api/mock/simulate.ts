// Generates plausible ball events for demo matches. Used to build the seed data
// and to keep the demo's live match moving. Not part of the real product.

import { replay, yetToBat, eligibleBowlers, type BallEvent, type DismissalKind, type MatchSetup } from '@/engine';

export type Rng = () => number;

/** Small deterministic PRNG so the demo looks the same on every launch. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(rng: Rng, items: [T, number][]): T => {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of items) {
    if ((r -= w) <= 0) return v;
  }
  return items[items.length - 1][0];
};

let counter = 0;
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Batting order is the XI as listed; the last five bowl. */
export function nextBall(
  setup: MatchSetup,
  events: BallEvent[],
  rng: Rng,
  matchId: string,
  at: Date,
): BallEvent | null {
  const state = replay(setup, events);
  const s = state.current;
  if (!s) return null;
  const c = setup.conditions;

  const waiting = yetToBat(setup, s);
  const striker = s.strikerId ?? waiting.shift()!;
  const nonStriker = s.nonStrikerId ?? waiting.shift()!;

  let bowlerId = s.bowlerId;
  if (!bowlerId) {
    const team = setup.teams.find((t) => t.id === s.bowlingTeamId)!;
    const attack = new Set(team.players.slice(-5).map((p) => p.id));
    const options = eligibleBowlers(setup, s).filter((b) => !b.reason && attack.has(b.id));
    options.sort((a, b) => (s.bowlers.find((x) => x.playerId === a.id)?.balls ?? 0) - (s.bowlers.find((x) => x.playerId === b.id)?.balls ?? 0));
    bowlerId = (options[Math.floor(rng() * Math.min(2, options.length))] ?? options[0])?.id ?? team.players[team.players.length - 1].id;
  }

  const over = Math.floor(s.legalBalls / c.ballsPerOver);
  const death = over >= c.oversPerInnings - 4;
  const powerplay = over < c.powerplayOvers;
  const outcome = pick<string>(rng, [
    ['dot', death ? 26 : 36],
    ['1', 32],
    ['2', 9],
    ['3', 1],
    ['4', powerplay || death ? 11 : 8],
    ['6', death ? 6 : 3],
    ['wide', 4],
    ['noBall', 1.2],
    ['legBye', 2],
    ['bye', 0.8],
    ['wicket', death ? 6.5 : 4.2],
  ]);

  const seq = events.filter((e) => e.innings === s.number).length + 1;
  const base = {
    id: newId('ball'),
    clientId: newId('c'),
    matchId,
    innings: s.number,
    seq,
    kind: 'delivery' as const,
    strikerId: striker,
    nonStrikerId: nonStriker,
    bowlerId,
    bat: 0,
    createdAt: at.toISOString(),
    createdBy: 'demo-scorer',
  };
  const shot = (runs: number) => ({
    angle: Math.round(rng() * 360),
    distance: (runs >= 4 ? 3 : runs >= 2 ? 2 : 1) as 1 | 2 | 3,
  });

  switch (outcome) {
    case 'dot':
      return base;
    case '1':
    case '2':
    case '3':
      return { ...base, bat: Number(outcome), shot: shot(Number(outcome)) };
    case '4':
    case '6':
      return { ...base, bat: Number(outcome), boundary: true, shot: shot(Number(outcome)) };
    case 'wide':
      return { ...base, extra: { kind: 'wide', runs: rng() < 0.15 ? 4 : 0 } };
    case 'noBall':
      return { ...base, bat: rng() < 0.4 ? 1 : 0, extra: { kind: 'noBall', runs: 0, nbVia: 'bat' } };
    case 'legBye':
      return { ...base, extra: { kind: 'legBye', runs: 1 } };
    case 'bye':
      return { ...base, extra: { kind: 'bye', runs: rng() < 0.2 ? 4 : 1 } };
    default: {
      const kind = pick<DismissalKind>(rng, [
        ['caught', 50],
        ['bowled', 24],
        ['lbw', 12],
        ['runOut', 9],
        ['stumped', 5],
      ]);
      const fielding = setup.teams.find((t) => t.id === s.bowlingTeamId)!.players;
      const fielder = kind === 'caught' || kind === 'runOut' ? fielding[Math.floor(rng() * fielding.length)].id : kind === 'stumped' ? fielding[1].id : undefined;
      const playerOutId = kind === 'runOut' && rng() < 0.4 ? nonStriker : striker;
      return {
        ...base,
        wicket: { kind, playerOutId, fielderId: fielder },
        newBatterId: waiting[0],
      };
    }
  }
}

/** Plays balls until `stop` says so or the match ends. */
export function simulate(
  setup: MatchSetup,
  events: BallEvent[],
  rng: Rng,
  matchId: string,
  start: Date,
  stop: (events: BallEvent[]) => boolean = () => false,
): BallEvent[] {
  const out = [...events];
  let t = start.getTime();
  for (let i = 0; i < 700; i++) {
    if (stop(out)) break;
    const ball = nextBall(setup, out, rng, matchId, new Date(t));
    if (!ball) break;
    out.push(ball);
    t += 35_000 + Math.floor(rng() * 20_000);
  }
  return out;
}
