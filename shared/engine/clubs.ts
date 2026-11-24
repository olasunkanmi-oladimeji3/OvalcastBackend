// Telling clubs apart by name: near duplicates ("Ikoyi CC" and "Ikoyi Cricket Club", typos), so
// nobody creates a club, or a one-off side, that already exists. Shared by the app, website and server.

/** Words that don't tell clubs apart: "Ikoyi CC", "Ikoyi Cricket Club" and "The Ikoyi Club" are one name. */
const FILLER = new Set(['cc', 'cricket', 'club', 'the', 'of', 'and', 'fc', 'sc', 'sports', 'xi', 'team', 'ltd', 'limited']);

/** A club name's telling words, lower case, without punctuation or filler. */
export function clubWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
}

/** Edits between two words (insert, delete, change one letter), stopping once past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/** Whether two words are the same allowing a typo or two (one for short words). */
const sameWord = (a: string, b: string) => a === b || distance(a, b, a.length <= 4 || b.length <= 4 ? 1 : 2) <= (a.length <= 4 || b.length <= 4 ? 1 : 2);

/**
 * How alike a typed club name is to an existing club, 0 to 1: the share of telling words they have in
 * common (allowing typos), or a short name typed in full (HPCC). Same city adds a little.
 */
export function clubSimilarity(typed: string, club: { name: string; shortName: string; city?: string }, city?: string): number {
  const a = clubWords(typed);
  const b = clubWords(club.name);
  let score = 0;
  if (a.length && b.length) {
    const shared = a.filter((w) => b.some((x) => sameWord(w, x))).length;
    score = shared / Math.max(a.length, b.length);
    // The whole telling name squeezed together ("lekkiwaves" v "Lekki Waves").
    if (sameWord(a.join(''), b.join(''))) score = Math.max(score, 0.95);
  }
  const short = typed.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (short.length >= 2 && short === club.shortName.toLowerCase()) score = Math.max(score, 0.9);
  if (score > 0 && city && club.city && city.trim().toLowerCase() === club.city.trim().toLowerCase()) score = Math.min(1, score + 0.1);
  return score;
}

/** Existing clubs that look like the one being named: the likeliest first. One-off sides never count. */
export function similarClubs<T extends { name: string; shortName: string; city?: string; adHoc?: boolean }>(typed: string, clubs: T[], city?: string, limit = 5): T[] {
  if (clubWords(typed).length === 0 && typed.trim().length < 2) return [];
  return clubs
    .filter((c) => !c.adHoc)
    .map((c) => ({ c, s: clubSimilarity(typed, c, city) }))
    .filter((x) => x.s >= 0.6)
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map((x) => x.c);
}
