// Matches that aren't played out: what each kind of decision means for the
// match, the table and the knockouts. Shared by the app, the website and the server.
//
// Postponed: no result yet; it will be played another day.
// Cancelled, no result, abandoned: points shared (the competition's no-result points).
// Walkover, conceded, awarded: a win for one side, a loss for the other.
// Neither side turned up: both lose.
// None of them count towards net run rate. In a knockout, one called off still
// needs a side to go through (by the competition's rule, e.g. higher group finish).

import type { MatchDecisionKind, DecisionReason } from '@/api/types';

export const DECISION_KINDS: { kind: MatchDecisionKind; label: string; sub: string; when: 'before' | 'during' | 'after' | 'beforeOrDuring' }[] = [
  { kind: 'postponed', label: 'Postponed', sub: 'Play it another day. No points yet.', when: 'before' },
  { kind: 'cancelled', label: 'Cancelled', sub: 'Not being played or replayed. Points shared.', when: 'before' },
  { kind: 'walkover', label: 'Walkover', sub: 'One side didn’t turn up, couldn’t raise a side, or refused to play. The other side wins.', when: 'before' },
  { kind: 'doubleForfeit', label: 'Neither side turned up', sub: 'Both sides lose.', when: 'before' },
  { kind: 'noResult', label: 'No result', sub: 'Weather or the ground stopped it before a result. Points shared.', when: 'beforeOrDuring' },
  { kind: 'abandoned', label: 'Abandoned', sub: 'Started but couldn’t finish. Points shared.', when: 'during' },
  { kind: 'conceded', label: 'Conceded', sub: 'One side gave up during the match. The other side wins.', when: 'during' },
  { kind: 'awarded', label: 'Awarded by the league', sub: 'The league gives the match to one side, e.g. after an ineligible player. Overturns the result.', when: 'after' },
];

export const DECISION_REASONS: Record<DecisionReason, string> = {
  weather: 'Rain or bad weather',
  groundUnfit: 'Ground unfit or unavailable',
  noShow: 'Didn’t turn up',
  notEnoughPlayers: 'Couldn’t raise a side',
  lateArrival: 'Arrived too late to play',
  refusedToPlay: 'Refused to play',
  ineligiblePlayer: 'Fielded an ineligible player',
  misconduct: 'Misconduct',
  safety: 'Safety or security',
  other: 'Something else',
};

/** The reasons that make sense for each kind, first one the usual. */
export const REASONS_FOR: Record<MatchDecisionKind, DecisionReason[]> = {
  postponed: ['weather', 'groundUnfit', 'safety', 'other'],
  cancelled: ['groundUnfit', 'weather', 'safety', 'other'],
  noResult: ['weather', 'groundUnfit', 'safety', 'other'],
  abandoned: ['weather', 'safety', 'groundUnfit', 'other'],
  walkover: ['noShow', 'notEnoughPlayers', 'lateArrival', 'refusedToPlay', 'other'],
  doubleForfeit: ['noShow', 'other'],
  conceded: ['notEnoughPlayers', 'misconduct', 'safety', 'other'],
  awarded: ['ineligiblePlayer', 'misconduct', 'refusedToPlay', 'other'],
};

/** A side wins this kind of decision outright. */
export const decisionHasWinner = (kind: MatchDecisionKind) => kind === 'walkover' || kind === 'conceded' || kind === 'awarded';
/** Points are shared. */
export const decisionSharesPoints = (kind: MatchDecisionKind) => kind === 'cancelled' || kind === 'noResult' || kind === 'abandoned';

/** Which decisions fit the match as it stands. */
export function decisionsFor(status: string): MatchDecisionKind[] {
  const started = status === 'live' || status === 'inningsBreak';
  const finished = status === 'completed';
  return DECISION_KINDS.filter((d) => (finished ? d.when === 'after' : started ? d.when === 'during' || d.when === 'beforeOrDuring' : d.when === 'before' || d.when === 'beforeOrDuring')).map((d) => d.kind);
}

/** The line shown as the result. */
export function decisionText(kind: MatchDecisionKind, names: { winner?: string; loser?: string }, reason?: DecisionReason): string {
  const why = reason ? DECISION_REASONS[reason].toLowerCase() : '';
  switch (kind) {
    case 'postponed':
      return `Postponed${why ? `: ${why}` : ''}`;
    case 'cancelled':
      return `Cancelled${why ? `: ${why}` : ''}`;
    case 'noResult':
      return `No result${why ? `: ${why}` : ''}`;
    case 'abandoned':
      return `Abandoned${why ? `: ${why}` : ''}`;
    case 'walkover':
      return `${names.winner} won by walkover: ${names.loser} ${reason === 'notEnoughPlayers' ? 'couldn’t raise a side' : reason === 'lateArrival' ? 'arrived too late' : reason === 'refusedToPlay' ? 'refused to play' : 'didn’t turn up'}`;
    case 'doubleForfeit':
      return 'Neither side turned up: both forfeit';
    case 'conceded':
      return `${names.winner} won: ${names.loser} conceded`;
    case 'awarded':
      return `${names.winner} awarded the match${why ? `: ${names.loser} ${why === 'fielded an ineligible player' ? 'fielded an ineligible player' : why}` : ''}`;
  }
}

/** How the result is recorded for each kind, and the match's status afterwards. */
export function decisionEffect(kind: MatchDecisionKind): { status: 'scheduled' | 'abandoned' | 'completed'; outcome?: 'noResult' | 'abandoned' | 'cancelled' | 'walkover' | 'doubleForfeit' } {
  switch (kind) {
    case 'postponed':
      return { status: 'scheduled' };
    case 'cancelled':
      return { status: 'abandoned', outcome: 'cancelled' };
    case 'noResult':
      return { status: 'abandoned', outcome: 'noResult' };
    case 'abandoned':
      return { status: 'abandoned', outcome: 'abandoned' };
    case 'doubleForfeit':
      return { status: 'completed', outcome: 'doubleForfeit' };
    default:
      return { status: 'completed', outcome: 'walkover' };
  }
}
