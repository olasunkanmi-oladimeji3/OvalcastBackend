// What people rate someone on, for each path in cricket: playing, scoring, umpiring,
// looking after the ground, coaching. Each aspect is 1 to 5 stars. A rating is for one
// match, or overall (no match).

export type RatedRole = 'player' | 'scorer' | 'umpire' | 'groundsman' | 'coach';

/** The paths in the order profiles show them. */
export const RATED_ROLES: RatedRole[] = ['player', 'scorer', 'umpire', 'groundsman', 'coach'];

export const RATED_LABEL: Record<RatedRole, string> = { player: 'Player', scorer: 'Scorer', umpire: 'Umpire', groundsman: 'Groundsman', coach: 'Coach' };

export const RATING_ASPECTS: Record<RatedRole, { key: string; label: string }[]> = {
  player: [
    { key: 'skill', label: 'Skill on the day' },
    { key: 'spirit', label: 'Played in the right spirit' },
    { key: 'teamwork', label: 'Good team-mate' },
    { key: 'reliability', label: 'On time and ready' },
  ],
  scorer: [
    { key: 'accuracy', label: 'Accurate scorebook' },
    { key: 'live', label: 'Kept the live score up to date' },
    { key: 'punctuality', label: 'On time and ready' },
    { key: 'communication', label: 'Worked well with the umpires' },
  ],
  umpire: [
    { key: 'decisions', label: 'Good decisions' },
    { key: 'consistency', label: 'Consistent for both sides' },
    { key: 'control', label: 'Kept the game under control' },
    { key: 'punctuality', label: 'On time and ready' },
  ],
  groundsman: [
    { key: 'pitch', label: 'Pitch' },
    { key: 'outfield', label: 'Outfield' },
    { key: 'readiness', label: 'Ground ready on time' },
  ],
  coach: [
    { key: 'sessions', label: 'Well-run sessions' },
    { key: 'improvement', label: 'Players improved' },
    { key: 'communication', label: 'Clear and encouraging' },
  ],
};

/** The average across aspects, to one decimal place. */
export const ratingAverage = (scores: Record<string, number>) => {
  const v = Object.values(scores).filter((n) => n >= 1 && n <= 5);
  return v.length ? Math.round((v.reduce((s, n) => s + n, 0) / v.length) * 10) / 10 : 0;
};

/** Every aspect for the role is scored 1 to 5, and nothing else. */
export const ratingProblem = (role: RatedRole, scores: Record<string, number>) => {
  const keys = RATING_ASPECTS[role].map((a) => a.key);
  if (keys.some((k) => !(scores[k] >= 1 && scores[k] <= 5))) return 'Give every part a score from 1 to 5';
  if (Object.keys(scores).some((k) => !keys.includes(k))) return 'Unknown part to rate';
  return undefined;
};

/**
 * One official's rating to show on a card: for the role asked about, or across their official roles
 * (not as a player), weighted by how many ratings each has. Undefined until someone rates them.
 */
export function officialRating(ratings: { role: RatedRole; count: number; average: number }[], role?: RatedRole): { average: number; count: number } | undefined {
  const mine = ratings.filter((r) => r.count > 0 && (role ? r.role === role : r.role !== 'player'));
  const count = mine.reduce((t, r) => t + r.count, 0);
  if (!count) return undefined;
  return { average: Math.round((mine.reduce((t, r) => t + r.average * r.count, 0) / count) * 10) / 10, count };
}
