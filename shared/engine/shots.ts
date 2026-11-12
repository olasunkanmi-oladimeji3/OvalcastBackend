// Shot analysis from the shot wheel: where a batter scores, and where batters
// score off a bowler. Built from ball events, so it agrees with every scorecard.
//
// ShotData.angle is measured as the shot wheel records a tap: degrees from
// directly behind the batter, round through the leg side, for a right-hander.
// So 0 to 45 is fine leg, 180 is straight, 270 to 315 is point. Left-handers'
// shots are stored mirrored, so zones read the same for both.

import { activeEvents } from './engine';
import type { BallEvent, DismissalKind, ShotData } from './types';

/** Eight scoring areas, from behind square on the leg side round to third man. */
export const SHOT_ZONES = ['Fine leg', 'Square leg', 'Midwicket', 'Long on', 'Long off', 'Cover', 'Point', 'Third man'] as const;
export type ShotZone = (typeof SHOT_ZONES)[number];
const OFF_SIDE: ShotZone[] = ['Long off', 'Cover', 'Point', 'Third man'];
const STRAIGHT: ShotZone[] = ['Long on', 'Long off'];
const BEHIND: ShotZone[] = ['Fine leg', 'Third man'];

export function zoneOf(shot: ShotData): ShotZone {
  const fromBehind = ((shot.angle % 360) + 360) % 360;
  return SHOT_ZONES[Math.min(7, Math.floor(fromBehind / 45))];
}

export interface ZoneLine {
  zone: ShotZone;
  runs: number;
  shots: number;
  boundaries: number;
}

export interface ShotProfile {
  /** Every scoring shot with wheel data, newest first, for drawing the wheel. */
  shots: { runs: number; shot: ShotData }[];
  zones: ZoneLine[];
  runs: number;
  boundaries: number;
  /** Share of runs through the off side, 0 to 1. */
  offSide: number;
  /** Plain-language reading of the wheel, a sentence or two. */
  summary: string[];
}

export interface BowlingShotProfile extends ShotProfile {
  balls: number;
  dots: number;
  dismissals: { kind: DismissalKind; count: number }[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const lower = (z: string) => z.toLowerCase();

function zonesOf(shots: { runs: number; shot: ShotData; boundary?: boolean }[]): ZoneLine[] {
  const lines = SHOT_ZONES.map((zone) => ({ zone, runs: 0, shots: 0, boundaries: 0 }));
  for (const s of shots) {
    const l = lines[SHOT_ZONES.indexOf(zoneOf(s.shot))];
    l.runs += s.runs;
    l.shots += 1;
    if (s.boundary ?? s.runs >= 4) l.boundaries += 1;
  }
  return lines;
}

function read(zones: ZoneLine[], runs: number, who: 'batter' | 'bowler'): string[] {
  if (runs === 0) return [];
  const sum = (names: ShotZone[]) => zones.filter((z) => names.includes(z.zone)).reduce((t, z) => t + z.runs, 0) / runs;
  const off = sum(OFF_SIDE);
  const top = [...zones].sort((a, b) => b.runs - a.runs);
  const boundaries = zones.reduce((t, z) => t + z.boundaries, 0);
  const topFours = [...zones].sort((a, b) => b.boundaries - a.boundaries)[0];
  const lean = off >= 0.58 ? 'off side' : off <= 0.42 ? 'leg side' : undefined;
  const out: string[] = [];
  if (who === 'batter') {
    out.push(lean ? `Mostly an ${lean === 'off side' ? 'off-side' : 'leg-side'} player: ${pct(lean === 'off side' ? off : 1 - off)} of runs on the ${lean}, most through ${lower(top[0].zone)} and ${lower(top[1].zone)}.` : `Scores all round the ground: ${pct(off)} on the off side, most through ${lower(top[0].zone)}.`);
    if (boundaries >= 3) out.push(`${topFours.boundaries} of ${boundaries} boundaries went to ${lower(topFours.zone)}${sum(STRAIGHT) >= 0.3 ? ', and they hit straight a lot' : sum(BEHIND) >= 0.25 ? ', with plenty played late behind square' : ''}.`);
  } else {
    out.push(`Batters score most off them through ${lower(top[0].zone)} (${pct(top[0].runs / runs)} of runs)${lean ? `, and ${pct(lean === 'off side' ? off : 1 - off)} on the ${lean}` : ''}.`);
    if (boundaries >= 3) out.push(`The boundaries mostly go to ${lower(topFours.zone)}, so that is where to put a sweeper.`);
  }
  return out;
}

const BOWLER_WICKETS: DismissalKind[] = ['bowled', 'caught', 'lbw', 'stumped', 'hitWicket'];

/** A player's shot profile from every match's ball events. */
export function playerShotProfile(playerId: string, matches: BallEvent[][]): { batting?: ShotProfile; bowling?: BowlingShotProfile } {
  const balls = matches.flatMap((m) => activeEvents(m));
  const hit = balls.filter((e) => e.strikerId === playerId && e.bat > 0 && e.shot).map((e) => ({ runs: e.bat, shot: e.shot!, boundary: e.boundary, at: e.createdAt }));
  const bowled = balls.filter((e) => e.bowlerId === playerId);
  const conceded = bowled.filter((e) => e.bat > 0 && e.shot).map((e) => ({ runs: e.bat, shot: e.shot!, boundary: e.boundary, at: e.createdAt }));

  const profile = (shots: typeof hit, who: 'batter' | 'bowler'): ShotProfile => {
    const zones = zonesOf(shots);
    const runs = zones.reduce((t, z) => t + z.runs, 0);
    return {
      shots: [...shots].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 120).map(({ runs: r, shot }) => ({ runs: r, shot })),
      zones,
      runs,
      boundaries: zones.reduce((t, z) => t + z.boundaries, 0),
      offSide: runs ? zones.filter((z) => OFF_SIDE.includes(z.zone)).reduce((t, z) => t + z.runs, 0) / runs : 0,
      summary: read(zones, runs, who),
    };
  };

  const out: { batting?: ShotProfile; bowling?: BowlingShotProfile } = {};
  if (hit.length) out.batting = profile(hit, 'batter');
  if (bowled.length) {
    const legal = bowled.filter((e) => e.extra?.kind !== 'wide' && e.extra?.kind !== 'noBall');
    const dots = legal.filter((e) => e.bat === 0 && !e.extra).length;
    const counts = new Map<DismissalKind, number>();
    for (const e of bowled) if (e.wicket && BOWLER_WICKETS.includes(e.wicket.kind)) counts.set(e.wicket.kind, (counts.get(e.wicket.kind) ?? 0) + 1);
    const dismissals = [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
    const base = profile(conceded, 'bowler');
    const stumps = (counts.get('bowled') ?? 0) + (counts.get('lbw') ?? 0);
    const wickets = dismissals.reduce((t, d) => t + d.count, 0);
    const extra = [`${pct(legal.length ? dots / legal.length : 0)} of their balls are dots.`];
    if (wickets >= 3) extra.push(stumps / wickets >= 0.5 ? `${stumps} of ${wickets} wickets bowled or lbw: they attack the stumps.` : `${counts.get('caught') ?? 0} of ${wickets} wickets caught: they get batters to take them on.`);
    out.bowling = { ...base, summary: [...base.summary, ...extra], balls: legal.length, dots, dismissals };
  }
  return out;
}
