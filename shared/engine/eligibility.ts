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
  /** When they joined that club's squad (ISO), to tell their main club in a season. */
  since?: string;
}

/**
 * An organisation's season: every one of its leagues with the same season label. A player plays for
 * one club per league, always. A second club in another league of the season is a QYP place: the
 * season allows it, the player is within its age on the season's first day, and the organisation
 * approves them. Their main club is the first they joined that season (the organisation can swap).
 */
export interface SeasonContext {
  orgId: string;
  season: string;
  qyp: { enabled: boolean; maxAge: number };
  /** The day the season's first league starts (YYYY-MM-DD or ISO): QYP age is judged on it. */
  startsOn: string;
  /** The season's leagues. */
  leagueIds: string[];
  /** The organisation's QYP decisions for this season, by person. */
  decisions: { playerId: string; status: 'pending' | 'approved' | 'declined'; mainTeamId?: string }[];
}

/** A player's clubs in a season: their main club (first joined, unless the organisation swapped) and their QYP club. */
export function seasonClubs(playerId: string, season: SeasonContext, regs: RegistrationRef[]): { main?: string; qyp?: string; all: string[] } {
  const mine = regs.filter((r) => r.playerId === playerId && r.status === 'active' && season.leagueIds.includes(r.competitionId)).sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
  const all = [...new Set(mine.map((r) => r.teamId))];
  const chosen = season.decisions.find((d) => d.playerId === playerId)?.mainTeamId;
  const main = chosen && all.includes(chosen) ? chosen : all[0];
  return { main, qyp: all.find((t) => t !== main), all };
}

/**
 * When a player's main and QYP clubs meet in a season, they can't play unless the organisation
 * allows it for that match and club. Returns why not, or undefined when they may play.
 */
export function seasonClashReason(args: { playerId: string; teamId: string; otherTeamId: string; season: SeasonContext; regs: RegistrationRef[]; allowedTeamId?: string; teamName?: (id: string) => string }): string | undefined {
  const { all, main } = seasonClubs(args.playerId, args.season, args.regs);
  if (!all.includes(args.teamId) || !all.includes(args.otherTeamId)) return undefined;
  if (args.allowedTeamId === args.teamId) return undefined;
  const name = (id: string) => args.teamName?.(id) ?? 'their other club';
  return `Plays for both clubs this season (main club ${name(main ?? args.teamId)}). Blocked when they meet unless the organisation allows it for this match`;
}

/**
 * Where a transfer is. A club that asks waits for the player to agree (`awaitingPlayer`); a player who
 * asks waits for the club they want to join (`awaitingNewClub`). Then the player's current club
 * releases them (`awaitingClub`) and the league approves (`awaitingLeague`).
 */
export type TransferStatus = 'awaitingPlayer' | 'awaitingNewClub' | 'awaitingClub' | 'awaitingLeague' | 'disputed' | 'approved' | 'rejected' | 'withdrawn';

/** Transfers still being decided: they count towards a player's limit and can be withdrawn. */
export const OPEN_TRANSFER: readonly TransferStatus[] = ['awaitingPlayer', 'awaitingNewClub', 'awaitingClub', 'awaitingLeague', 'disputed'];
export const transferOpen = (t: { status: TransferStatus }) => OPEN_TRANSFER.includes(t.status);

export interface TransferRef {
  competitionId: string;
  playerId: string;
  status: TransferStatus;
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

/** Whole years old on a date: `dob` and `on` as YYYY-MM-DD (or full ISO dates). */
export function ageOn(dob: string, on: string): number {
  const [by, bm, bd] = dob.slice(0, 10).split('-').map(Number);
  const [y, m, d] = on.slice(0, 10).split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Whether a club may ask for a player (or a player ask to join a club) now. The league admin's approval re-runs this. */
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
  // One club per player in a league, always: a second club is in another league of the season (QYP).
  if (args.kind === 'dual') return { ok: false, reason: `A player plays for one club in ${league.name}. A second club in another league this season is a QYP place, approved by the organisation` };
  const used = args.transfers.filter(
    (t) => t.playerId === playerId && t.competitionId === league.id && (t.status === 'approved' || (!args.excludePending && transferOpen(t))),
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

/**
 * Whether a person may be registered for a club in a league, checked whenever a squad is
 * registered (a club joining a league, the next season's edition, a player added or joining by
 * invite). `regs` are every registration the person has, under any of their player records, with
 * `playerId` set to the same id for all of them. The answer is a squad place (as their main club
 * when it's their first club here, otherwise a second club), or a hold with the reason.
 * `canChoose`: the hold is about having more than one club here, which the player settles by
 * choosing their clubs; other holds need a league admin.
 */
export function registrationCheck(args: {
  playerId: string;
  teamId: string;
  league: LeagueRef;
  leagues: LeagueRef[];
  regs: RegistrationRef[];
  teamName?: (teamId: string) => string;
  playerBirthDate?: string;
  leagueStartsOn?: string;
  now?: Date;
  /** The league's season, when it has one: second clubs across its leagues follow the season's QYP rules. */
  season?: SeasonContext;
}): { ok: true; primary: boolean } | { ok: false; reason: string; canChoose: boolean; qypRequest?: { mainTeamId: string; qypTeamId: string } } {
  const { league, playerId, teamId, regs } = args;
  const name = (id: string) => args.teamName?.(id) ?? 'another club';
  const rules = league.playerRules;
  const here = regs.filter((r) => r.playerId === playerId && r.competitionId === league.id && r.status === 'active' && r.teamId !== teamId);
  const clubs = [...new Set(here.map((r) => r.teamId))];
  // One club per player in a league, always: fair play between the clubs in it.
  void rules;
  if (clubs.length) return { ok: false, reason: `Already plays for ${clubs.map(name).join(' and ')} in ${league.name}. A player plays for one club per league`, canChoose: true };
  const season = args.season;
  if (season) {
    // Their clubs in the season's other leagues (a club playing in two of them is still one club).
    const { all, main } = seasonClubs(playerId, season, regs.filter((r) => r.competitionId !== league.id));
    const others = all.filter((t) => t !== teamId);
    if (others.length) {
      const already = others.map(name).join(' and ');
      const label = `the ${season.season} season`;
      if (others.length >= 2) return { ok: false, reason: `Already plays for ${already} in ${label}. A QYP player has one second club`, canChoose: false };
      if (!season.qyp.enabled) return { ok: false, reason: `Already plays for ${already} in ${label}, which allows one club per player`, canChoose: true };
      if (!args.playerBirthDate) return { ok: false, reason: `Already plays for ${already}. A second club this season is for QYP players aged ${season.qyp.maxAge} or under, and there's no date of birth on record`, canChoose: true };
      const age = ageOn(args.playerBirthDate, season.startsOn);
      if (age > season.qyp.maxAge) return { ok: false, reason: `Already plays for ${already}. A second club this season is for QYP players aged ${season.qyp.maxAge} or under; they're ${age}`, canChoose: true };
      const decision = season.decisions.find((d) => d.playerId === playerId);
      if (decision?.status === 'declined') return { ok: false, reason: `The organisation declined them as a QYP player for ${label}`, canChoose: true };
      if (decision?.status !== 'approved') return { ok: false, reason: `Waiting for the organisation to approve them as a QYP player for ${label} (second club, with ${already})`, canChoose: false, qypRequest: { mainTeamId: main ?? others[0], qypTeamId: teamId } };
    }
  }
  // Leagues outside this season keep their own rules about players in other leagues.
  const outside = season ? args.leagues.filter((l) => !season.leagueIds.includes(l.id)) : args.leagues;
  const clash = otherLeagueConflicts(playerId, league, outside, regs)[0];
  if (clash) return { ok: false, reason: clash.reason, canChoose: false };
  return { ok: true, primary: clubs.length === 0 };
}

/**
 * Whether clubs can make offers in this league now: before it starts, or while a window is open.
 * `note` says when the next window opens, or that transfers are off.
 */
export function transferWindowNow(league: LeagueRef, now = new Date()): { open: boolean; note?: string } {
  const rules = league.playerRules;
  if (!rules.transfers) return { open: false, note: `${league.name} does not allow transfers once the league starts` };
  if (league.status === 'entries') return { open: true, note: 'Before the league starts' };
  const w = openWindow(rules, now);
  if (w) return { open: true, note: `${w.name} closes ${day(w.closesOn)}` };
  const next = nextWindow(rules, now);
  return { open: false, note: next ? `The transfer window is closed. ${next.name} opens ${day(next.opensOn)}` : 'The transfer window is closed for this season' };
}

/**
 * A qualified young player (QYP) for a league in its season: the season allows QYP, the player is
 * within its age on the season's first day, has exactly one club in the season's other leagues and
 * none in this one. Without a date of birth on record nobody is QYP.
 */
export function isQyp(playerId: string, leagueId: string, season: SeasonContext | undefined, regs: RegistrationRef[], birthDate: string | undefined): boolean {
  if (!season?.qyp.enabled || !birthDate) return false;
  if (regs.some((r) => r.playerId === playerId && r.competitionId === leagueId && r.status === 'active')) return false;
  const { all } = seasonClubs(playerId, season, regs);
  return all.length === 1 && ageOn(birthDate, season.startsOn) <= season.qyp.maxAge;
}
