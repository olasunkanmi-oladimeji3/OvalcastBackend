// Player eligibility: who may be registered where, and when a transfer is
// allowed. Pure functions so the app can warn early and the server can enforce
// the same rules.

export interface LeagueRules {
  /**
   * Playing for more than one club. `maxAge`: only players this age or under on the day the league
   * starts may add a second club (a qualified young player rule).
   */
  multiClub: { allowed: boolean; maxClubs: number; maxAge?: number };
  otherLeagues: 'allowed' | 'notSameOrganisation' | 'notAllowed';
  transfers: { windows: { name: string; opensOn: string; closesOn: string }[]; maxPerPlayer: number } | null;
}

export interface LeagueRef {
  id: string;
  orgId: string;
  name: string;
  status: 'entries' | 'inProgress' | 'completed';
  playerRules: LeagueRules;
}

export interface RegistrationRef {
  competitionId: string;
  playerId: string;
  teamId: string;
  primary: boolean;
  status: 'active' | 'ended';
}

export interface TransferRef {
  competitionId: string;
  playerId: string;
  status: 'awaitingClub' | 'awaitingLeague' | 'disputed' | 'approved' | 'rejected' | 'withdrawn';
}

export type Verdict = { ok: true } | { ok: false; reason: string };

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function openWindow(rules: LeagueRules, now = new Date()) {
  return rules.transfers?.windows.find((w) => new Date(w.opensOn) <= now && now <= new Date(w.closesOn));
}

export function nextWindow(rules: LeagueRules, now = new Date()) {
  return rules.transfers?.windows.filter((w) => new Date(w.opensOn) > now).sort((a, b) => a.opensOn.localeCompare(b.opensOn))[0];
}

/**
 * Leagues whose rules clash if this player is also in `target`. Checks both
 * ways: the target's own rule, and each other league's rule about the target.
 */
export function otherLeagueConflicts(playerId: string, target: LeagueRef, leagues: LeagueRef[], regs: RegistrationRef[]): { league: LeagueRef; reason: string }[] {
  const active = new Set(regs.filter((r) => r.playerId === playerId && r.status === 'active' && r.competitionId !== target.id).map((r) => r.competitionId));
  const out: { league: LeagueRef; reason: string }[] = [];
  for (const other of leagues) {
    if (!active.has(other.id) || other.status === 'completed') continue;
    const sameOrg = other.orgId === target.orgId;
    const blocks = (rule: LeagueRules['otherLeagues']) => rule === 'notAllowed' || (rule === 'notSameOrganisation' && sameOrg);
    if (blocks(target.playerRules.otherLeagues)) {
      out.push({ league: other, reason: `${target.name} does not allow players who also play in ${other.name}` });
    } else if (blocks(other.playerRules.otherLeagues)) {
      out.push({ league: other, reason: `${other.name} does not allow its players to join ${target.name}` });
    }
  }
  return out;
}

/** Whether a club may ask for a player now. The league admin's approval re-runs this. */
/** Whole years old on a date: `dob` and `on` as YYYY-MM-DD (or full ISO dates). */
export function ageOn(dob: string, on: string): number {
  const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number);
  const [y, m, d] = on.slice(0, 10).split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export function canTransfer(args: {
  playerId: string;
  fromTeamId: string;
  toTeamId: string;
  kind: 'move' | 'dual';
  league: LeagueRef;
  regs: RegistrationRef[];
  transfers: TransferRef[];
  now?: Date;
  /** Leave out the transfer being approved when counting the player's moves. */
  excludePending?: boolean;
  /** The player's date of birth (YYYY-MM-DD), for a league that limits second clubs by age. */
  playerBirthDate?: string;
  /** The day the league starts, which the age limit is judged on. */
  leagueStartsOn?: string;
}): Verdict {
  const { league, regs, playerId, now = new Date() } = args;
  const rules = league.playerRules;
  if (!rules.transfers) return { ok: false, reason: `${league.name} does not allow transfers once the league starts` };
  if (league.status !== 'entries' && !openWindow(rules, now)) {
    const next = nextWindow(rules, now);
    return { ok: false, reason: next ? `The transfer window is closed. ${next.name} opens ${day(next.opensOn)}` : 'The transfer window is closed for this season' };
  }
  const mine = regs.filter((r) => r.playerId === playerId && r.competitionId === league.id && r.status === 'active');
  if (!mine.some((r) => r.teamId === args.fromTeamId)) return { ok: false, reason: 'The player is not in that club’s squad for this league' };
  if (mine.some((r) => r.teamId === args.toTeamId)) return { ok: false, reason: 'The player is already in your squad for this league' };
  if (args.kind === 'dual') {
    if (!rules.multiClub.allowed) return { ok: false, reason: `${league.name} allows one club per player` };
    if (mine.length >= rules.multiClub.maxClubs) return { ok: false, reason: `Already plays for ${mine.length} clubs, the most ${league.name} allows` };
    const maxAge = rules.multiClub.maxAge;
    if (maxAge !== undefined) {
      const on = args.leagueStartsOn ?? now.toISOString();
      if (!args.playerBirthDate) return { ok: false, reason: `${league.name} lets players aged ${maxAge} or under play for a second club. Add the player’s date of birth first` };
      const age = ageOn(args.playerBirthDate, on);
      if (age > maxAge) return { ok: false, reason: `${league.name} lets players aged ${maxAge} or under play for a second club; they’re ${age} on ${day(on)}` };
    }
  }
  const used = args.transfers.filter(
    (t) => t.playerId === playerId && t.competitionId === league.id && (t.status === 'approved' || (!args.excludePending && (t.status === 'awaitingClub' || t.status === 'awaitingLeague' || t.status === 'disputed'))),
  ).length;
  if (used >= rules.transfers.maxPerPlayer) return { ok: false, reason: `Has used ${used === 1 ? 'their transfer' : `all ${used} transfers`} this season` };
  return { ok: true };
}

/** Which club a player turns out for when two of their clubs meet: the one they joined first. */
export function clubWhenClubsMeet(playerId: string, competitionId: string, teamIds: [string, string], regs: RegistrationRef[]): string | undefined {
  const mine = regs.filter((r) => r.playerId === playerId && r.competitionId === competitionId && r.status === 'active' && teamIds.includes(r.teamId));
  if (mine.length < 2) return mine[0]?.teamId;
  return (mine.find((r) => r.primary) ?? mine[0]).teamId;
}
