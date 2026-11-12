// The Ovalcast API contract. These types are what the backend returns from
// /api/v1. The mock API and the HTTP API both implement `OvalcastApi`, so
// screens never know which one they are talking to.

import type { BallEvent, PlayingConditions } from '@/engine';

export type ID = string;
export type ISODate = string;

export type Role = 'owner' | 'leagueAdmin' | 'scorer' | 'clubAdmin' | 'player';

export interface User {
  id: ID;
  name: string;
  /** Roles held in each organisation or club. */
  memberships: { orgId?: ID; clubId?: ID; role: Role }[];
  /** Fixtures this user is the assigned scorer for. */
  assignedMatchIds: ID[];
  /** The user's own player profile, if they play. */
  playerId?: ID;
  phone?: string;
  email?: string;
  phoneVerified: boolean;
  emailVerified: boolean;
  city?: string;
  /** Sets prices: Pro is in naira in Nigeria and in US dollars elsewhere. */
  country?: string;
  settings: UserSettings;
  /** Ovalcast's own operations staff: the staff console. Never a client role. */
  staff?: boolean;
  /** How they play, set by themselves: shown on their profile and used when a club adds them. */
  playing?: PlayingStyle;
  /** Clubs, players and competitions this user follows for results and wickets. */
  follows?: { teamIds: ID[]; playerIds: ID[]; competitionIds: ID[] };
}

export type ContactChannel = 'email' | 'phone';

export interface AuthSession {
  token: string;
  user: User;
}

/** A one-time code was sent. `destination` is masked, for example +234 *** *** 0199. */
export interface CodeSent {
  channel: ContactChannel;
  destination: string;
  expiresInSeconds: number;
  /** Wait this long before asking for another code. */
  resendInSeconds: number;
  /** Demo only: the code, since no SMS or email is really sent. Never returned in production. */
  devCode?: string;
}

export type SignInResult = { kind: 'signedIn'; session: AuthSession } | { kind: 'verify'; identifier: string; code: CodeSent };

export interface SignUpInput {
  name: string;
  /** One of email or phone is required; the first one is verified before sign-in. */
  email?: string;
  /** International form, for example +2348025550199. */
  phone?: string;
  password: string;
  city?: string;
  /** Sets currency, prices, time zone and payment methods. A country not on Ovalcast's list pays by card in US dollars. */
  country?: string;
  /** Player (the default): plays, officiates, coaches, runs a club or follows. Organisation: runs competitions. */
  accountType?: AccountType;
  /** Required for an organisation: created, with this person as owner, once the code is verified. */
  organisation?: { name: string; kind: OrganisationKind; city: string };
}

export type AccountType = 'player' | 'organisation';

/** Any currency Ovalcast prices in; see engine/countries. */
export type Currency = import('@/engine').CurrencyCode;

export interface UserSettings {
  /** Lower video quality, slower live updates and no autoplay, for mobile data. */
  dataSaver: boolean;
  /** How the user wants alerts: push always works; SMS and WhatsApp reach phones without the app open. */
  alerts: { push: boolean; sms: boolean; whatsapp: boolean };
  /** What to be told about. */
  alertTopics: { myMatches: boolean; myClubs: boolean; wickets: boolean; results: boolean; leagueAdmin: boolean };
  /** They've been through setting up their cricket career (or chosen to skip it). */
  careerSetupDone?: boolean;
  /** Chosen at sign-up. */
  accountType?: AccountType;
  /** An organisation signed up for but not created yet (its name was taken before the code was verified). */
  pendingOrganisation?: { name: string; kind: OrganisationKind; city: string; country: string };
}

export type StaffRole = 'captain' | 'viceCaptain' | 'coach' | 'manager' | 'physio' | 'scorer' | 'analyst' | 'kitManager';

export interface StaffMember {
  id: ID;
  name: string;
  role: StaffRole;
  phone?: string;
  /** Set when the staff member is also one of the club's players. */
  playerId?: ID;
  /** Set when the staff member has an Ovalcast account, linking to their profile. */
  userId?: ID;
}

/** What kind of body runs the competitions. Shapes the wording and the templates offered, never the rules. */
export type OrganisationKind = 'league' | 'association' | 'festival' | 'school' | 'academy' | 'corporate';

export interface CreateOrganisationInput {
  name: string;
  shortName: string;
  kind: OrganisationKind;
  city: string;
  country: string;
  about: string;
}

export interface Organisation {
  id: ID;
  name: string;
  shortName: string;
  city: string;
  about: string;
  founded: number;
  executives: { name: string; title: string }[];
  sponsors: string[];
  competitionIds: ID[];
  clubIds: ID[];
  country: string;
  /** Entry fees and prices are in this currency. */
  currency: Currency;
  honours: { season: string; competition: string; winnerTeamId: ID }[];
  seasonMoves: SeasonMove[];
  /** Organisation plan by contract; otherwise the plan of the admins who run it. */
  plan?: import('@/engine').PlanId;
  /** A YouTube stream key is saved; free streams are restreamed to the channel. */
  youtubeConnected?: boolean;
  kind?: OrganisationKind;
  /** Branding: shown on its pages, competitions and the stream overlay. */
  logoUrl?: string;
  coverUrl?: string;
  brandColor?: string;
}

export interface SeasonMove {
  season: string;
  teamId: ID;
  from: string;
  to: string;
  kind: 'promoted' | 'relegated';
  status: 'proposed' | 'confirmed';
}

export interface Team {
  id: ID;
  /** The organisation the club belongs to; a new club may have none yet. */
  orgId?: ID;
  city: string;
  name: string;
  shortName: string;
  /** Club colours: [primary, secondary]. */
  colors: [string, string];
  homeGround: string;
  founded: number;
  /** Uploaded logo. Without one, the badge shows the short name on the club colour. */
  logoUrl?: string;
  staff: StaffMember[];
  /** A quick side for a friendly, not a registered club. */
  adHoc?: boolean;
  /** A YouTube stream key is saved; free streams are restreamed to the channel. */
  youtubeConnected?: boolean;
  /** Practice sides: the club whose squad both sides pick from. */
  parentTeamId?: ID;
}

export type PlayerRole = 'batter' | 'bowler' | 'allRounder' | 'keeper';

export interface Player {
  id: ID;
  teamId: ID;
  name: string;
  shortName: string;
  role: PlayerRole;
  battingHand: 'R' | 'L';
  bowlingStyle?: string;
  /** A guest for one match, not registered with the club. */
  guest?: boolean;
  guestMatchId?: ID;
  /** Under 18: the public profile stays private unless a parent or guardian agreed. */
  minor?: boolean;
  guardianConsent?: boolean;
  /** YYYY-MM-DD. Only ever sent to the club's admins: never public. */
  dateOfBirth?: string;
}

export interface PlayerCareer {
  player: Player;
  matches: number;
  batting: { innings: number; runs: number; balls: number; notOuts: number; high: number; fifties: number; hundreds: number; fours: number; sixes: number };
  bowling: { balls: number; runs: number; wickets: number; best: string };
  fielding: { catches: number; runOuts: number; stumpings: number };
  recent: { matchId: ID; against: ID; runs?: number; balls?: number; wickets?: number; conceded?: number; date: ISODate }[];
}

export interface Region {
  id: ID;
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** Club cities that count as this region. */
  cities: string[];
}

export interface LeaderRow {
  playerId: ID;
  teamId: ID;
  /** The number the list is ranked by. */
  value: number;
  /** Supporting figures, for example "412 runs at 34.3, SR 141". */
  detail: string;
}

/** The best players in a region this season, by discipline. */
export interface RegionalLeaders {
  regionId: ID;
  season: string;
  batters: LeaderRow[];
  bowlers: LeaderRow[];
  keepers: LeaderRow[];
  fielders: LeaderRow[];
  allRounders: LeaderRow[];
}

/**
 * Who may play, set by the host when creating a league. Players are registered
 * with a club for a league, so the same player can be in different squads in
 * different leagues, or for two clubs in one league where these rules allow.
 */
export interface PlayerRules {
  /** More than one club in this league. When two of a player's clubs meet, they play for the first club they registered with. */
  /** `maxAge`: only players this age or under on the day the league starts may add a second club. */
  multiClub: { allowed: boolean; maxClubs: number; maxAge?: number };
  /** Whether players here may also be registered in other leagues. */
  otherLeagues: 'allowed' | 'notSameOrganisation' | 'notAllowed';
  /** Players not registered with the club who may play in an XI. */
  guestPlayersPerXI: number;
  /** Matches a player must play in the group stage to play in the knockouts. 0 for none. */
  minMatchesForKnockouts: number;
  /** The league approves each club's squad before its players can play. */
  squadApproval?: boolean;
  /** null: no transfers once the league starts. */
  transfers: { windows: { name: string; opensOn: ISODate; closesOn: ISODate }[]; maxPerPlayer: number } | null;
}

/** A player in a club's squad for one league. */
export interface Registration {
  id: ID;
  competitionId: ID;
  playerId: ID;
  teamId: ID;
  /** The player's first club in this league; they play for it when their clubs meet. */
  primary: boolean;
  since: ISODate;
  status: 'active' | 'ended';
  /** Leagues that approve squads: false until a league admin approves the player. */
  approved?: boolean;
}

/**
 * Moving a player during a transfer window, or adding a second club where the
 * league allows it (`dual`). Either the club that wants the player asks and the
 * player agrees, or the player asks and that club accepts. Then the player's
 * current club releases them and the league admin approves.
 */
export interface Transfer {
  id: ID;
  competitionId: ID;
  playerId: ID;
  fromTeamId: ID;
  toTeamId: ID;
  kind: 'move' | 'dual';
  /** `disputed`: the releasing club refused and the requesting club (or the player) asked the league to decide. */
  status: import('@/engine').TransferStatus;
  note?: string;
  createdAt: ISODate;
  /** Who asked first: the club that wants the player, or the player. */
  startedBy: 'club' | 'player';
  /** `player` entries recorded by a league admin (for a player not on Ovalcast) say so in the note. */
  history: { status: Transfer['status']; at: ISODate; by: 'requestingClub' | 'releasingClub' | 'league' | 'player'; note?: string }[];
}

export type StageKind = 'roundRobin' | 'superStage' | 'playoff' | 'knockout';

export interface Stage {
  id: ID;
  name: string;
  kind: StageKind;
  groups: { id: ID; name: string; teamIds: ID[] }[];
  /** Round robin: play each opponent twice, home and away. */
  doubleRound?: boolean;
  /** How teams leave this stage for the next one. */
  qualify?: { topPerGroup: number; toStageId: ID; carryForward: 'all' | 'qualifiersOnly' | 'fresh' };
}

export type CompetitionCategory = 'league' | 'cup' | 'festival' | 'representative' | 'schools' | 'corporate';

/** One tournament across the years, oldest edition first. `change` compares an edition with the one before. */
export interface SeriesSummary {
  seriesId: ID;
  /** The latest edition's name. */
  name: string;
  editions: {
    competitionId: ID;
    season: string;
    status: Competition['status'];
    teams: number;
    matchesPlayed: number;
    runs: number;
    /** The winner, once the edition is finished. */
    champion?: ID;
    change?: { teams: number; matchesPlayed: number; runs: number };
  }[];
}

export interface Competition {
  id: ID;
  orgId: ID;
  /** The same tournament across years: every edition shares it (the first edition's id). */
  seriesId?: ID;
  name: string;
  season: string;
  division: string;
  format: 'T20' | 'T10' | '50 overs' | 'The Hundred' | 'Custom';
  ballType: 'leather' | 'tennis';
  conditions: PlayingConditions;
  points: { win: number; tie: number; noResult: number; loss: number };
  tieBreakers: ('wins' | 'nrr' | 'headToHead')[];
  stages: Stage[];
  teamIds: ID[];
  status: 'entries' | 'inProgress' | 'completed';
  /** Open: any club may ask to join. Invite only: the league invites clubs. */
  entryPolicy: 'open' | 'inviteOnly';
  /** Entry fee in the organisation's currency; 0 for free. */
  entryFee: number;
  maxTeams: number;
  startsOn: ISODate;
  playerRules: PlayerRules;
  rulesDocument?: { name: string; version: number; uploadedAt: ISODate; sizeKb: number };
  seasonRules: string[];
  /** A league, cup, festival, interstate or other representative championship, schools or corporate. */
  category?: CompetitionCategory;
  /** Its own logo and cover image; falls back to the organisation's. */
  logoUrl?: string;
  coverUrl?: string;
  /** Division level within the organisation's season: 1 is the top. Drives promotion and relegation. */
  /** How a rain-shortened chase's target is set. Average run rate when unset. */
  rainRule?: import('@/engine').RainRule;
  tier?: number;
}

export type MatchStatus = 'scheduled' | 'toss' | 'live' | 'inningsBreak' | 'completed' | 'abandoned';

export interface InningsScore {
  teamId: ID;
  runs: number;
  wickets: number;
  balls: number;
  allOut: boolean;
}

export interface Match {
  id: ID;
  competitionId?: ID;
  stageId?: ID;
  groupId?: ID;
  title?: string;
  homeTeamId: ID;
  awayTeamId: ID;
  venue: string;
  startsAt: ISODate;
  status: MatchStatus;
  toss?: { wonByTeamId: ID; decision: 'bat' | 'bowl'; method: 'online' | 'manual'; at: ISODate };
  battingFirstTeamId?: ID;
  playingXI?: Record<ID, ID[]>;
  officials: { /** Names on the scorecard: those with accounts first, in the order of `umpireUserIds`, then names only. */ umpires: string[]; umpireUserIds?: ID[]; scorerUserId?: ID; scorerName?: string; /** Who prepared the ground: names, and accounts where they have one. */ groundsmen?: string[]; groundsmanUserIds?: ID[] };
  /** Who created a friendly; they and the clubs' admins can invite officials. */
  createdBy?: ID;
  /** Server-calculated summary, kept for lists and tables. */
  scores: InningsScore[];
  result?: { text: string; winnerTeamId?: ID; outcome: 'win' | 'tie' | 'noResult' | 'abandoned' | 'cancelled' | 'walkover' | 'doubleForfeit' };
  /** How the match was decided when it wasn't played out: postponed, cancelled, walkover, conceded, awarded and the rest. */
  decision?: MatchDecision;
  locked: boolean;
  streamId?: ID;
  /** Friendlies sit outside any competition; whoever creates one scores it. */
  friendly?: boolean;
  /** A friendly's own rules; league matches use the competition's. */
  conditions?: import('@/engine').PlayingConditions;
  /** Knockout matches: the round name, and labels while the teams are not known yet. */
  round?: string;
  placeholders?: { home?: string; away?: string };
  /** Where the winner goes next in a knockout bracket. */
  winnerTo?: { matchId: ID; side: 'home' | 'away' };
  /** Each side's captain and wicketkeeper, set when the match starts. */
  leaders?: Record<ID, { captainId?: ID; keeperId?: ID }>;
  /** A practice match inside one club: both sides pick from its squad. Kept out of official records. */
  practice?: boolean;
  /** Confirmed by the organiser after the match; the app only suggests one. */
  playerOfMatchId?: ID;
  /** Why a match ended without a result. */
  outcomeNote?: string;
  /** Overs cut by rain, bad light or a late start, and the chase's revised target. */
  reduced?: MatchReduction;
}

/** Who may play in a match, per club, after the league's player rules. */
export interface MatchEligibility {
  matchId: ID;
  guestPlayersAllowed: number;
  knockout: boolean;
  teams: Record<ID, { playerId: ID; ok: boolean; reason?: string; appearances: number }[]>;
}

export interface Payment {
  id: ID;
  entryId: ID;
  amount: number;
  currency: Currency;
  method: 'card' | 'bankTransfer' | 'ussd' | 'mobileMoney' | 'cash';
  /** Flutterwave for every online payment; cash is marked by the league. */
  provider: 'flutterwave' | 'cash';
  reference: string;
  status: 'paid' | 'pending' | 'failed';
  at: ISODate;
  /** The payout this payment went out in. Online payments only. */
  settlementId?: ID;
  /** Paid with a card from outside the league's country, which costs more. */
  international?: boolean;
  /** Ovalcast's entry share this payment was charged at (0.02 = 2%). Older payments have none: 2% applied. */
  serviceRate?: number;
}

/**
 * Where a league's entry fees go. Flutterwave holds the account
 * as a subaccount and settles each payment to it; Ovalcast keeps only the last
 * four digits.
 */
export interface PayoutAccount {
  orgId: ID;
  kind: 'bank' | 'mobileMoney';
  /** "GTBank", "MTN MoMo". */
  institution: string;
  institutionCode: string;
  last4: string;
  /** The name the bank or network returned when the number was checked. */
  accountName: string;
  schedule: import('@/engine').SettlementSchedule;
  verifiedAt: ISODate;
  changedByName: string;
  /** Payouts pause for 24 hours after the account changes, so a stolen login cannot quietly redirect money. */
  holdUntil?: ISODate;
}

/** One payout from the provider to the league's account. */
export interface Settlement {
  id: ID;
  orgId: ID;
  amount: number;
  currency: Currency;
  paymentCount: number;
  status: 'processing' | 'paid' | 'failed';
  /** The reference on the league's bank statement. */
  reference: string;
  /** "GTBank ending 4821". */
  accountLabel: string;
  kind: 'scheduled' | 'withdrawal';
  createdAt: ISODate;
  paidAt?: ISODate;
}

export interface FinanceLine {
  paymentId: ID;
  international?: boolean;
  entryId: ID;
  competitionId: ID;
  teamId: ID;
  method: Payment['method'];
  provider: string;
  reference: string;
  at: ISODate;
  gross: number;
  providerFee: number;
  serviceFee: number;
  net: number;
  /** cash: collected by the league in person. awaiting: with the provider until the next payout. settled: paid into the league's account. */
  state: 'cash' | 'awaiting' | 'settled';
  settlementId?: ID;
  expectedOn?: ISODate;
}

/** A league's entry fee money, for its admins only. */
export interface LeagueFinance {
  orgId: ID;
  currency: Currency;
  account?: PayoutAccount;
  totals: { collected: number; fees: number; settled: number; awaiting: number; cash: number; outstanding: number };
  /** Undefined `on` means the league withdraws by hand. */
  nextPayout?: { amount: number; on?: ISODate };
  competitions: { competitionId: ID; entryFee: number; clubs: number; paid: number; gross: number; net: number; outstanding: number }[];
  unpaid: { entryId: ID; competitionId: ID; teamId: ID; amount: number; acceptedAt?: ISODate }[];
  lines: FinanceLine[];
  settlements: Settlement[];
}

export interface PayoutInstitution {
  code: string;
  name: string;
  kind: 'bank' | 'mobileMoney';
}

export interface PayoutAccountInput {
  kind: 'bank' | 'mobileMoney';
  institutionCode: string;
  /** Leave out to keep the current account and change only when the league is paid. */
  accountNumber?: string;
  schedule: import('@/engine').SettlementSchedule;
  /** The admin's password again: changing where money goes is a sensitive action. */
  password: string;
}

export type OfficialRole = 'scorer' | 'umpire' | 'groundsman' | 'coach';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Certificate {
  id: ID;
  role: OfficialRole;
  title: string;
  issuer: string;
  year: number;
  fileName: string;
  /** The uploaded PDF or image; a CDN URL in production. */
  fileUrl: string;
  /** Checked by Ovalcast or a governing body before it shows as verified. */
  status: 'pending' | 'verified' | 'rejected';
  uploadedAt: ISODate;
}

/** What a person offers as an official or coach. */
export interface OfficiatingProfile {
  roles: OfficialRole[];
  /** Open to being invited to matches. */
  available: boolean;
  days: Weekday[];
  /** Dates they can't do, as YYYY-MM-DD (holidays, work). Searches for that date leave them out. */
  awayDates?: string[];
  /** How far they will travel to a ground, in km. */
  travelKm: number;
  /** Match fee they usually ask, in their currency; 0 or unset for volunteers. */
  fee?: number;
  bio: string;
  /** Grounds a groundsman looks after, or a coach trains at. */
  grounds: string[];
  certificates: Certificate[];
}

/** Public view of a person: what they do and what they have done. */
export interface PersonProfile {
  userId: ID;
  name: string;
  city?: string;
  regionId?: ID;
  playerId?: ID;
  clubIds: ID[];
  officiating: OfficiatingProfile;
  /** Each path's record: matches played, scored, umpired, grounds prepared, and coached. */
  stats: { scored: number; umpired: number; played: number; coached: number; groundsman: number };
  scored: Match[];
  umpired: Match[];
  /** Matches whose ground they prepared. */
  prepared: Match[];
  memberSince: ISODate;
  playing?: PlayingStyle;
  /** What people they've worked with think, by role. */
  ratings: RatingSummary[];
  /** What the viewer may rate them for: matches they were both part of. Empty for themselves. */
  rateable: { role: import('@/engine').RatedRole; matchId?: ID; label: string }[];
}

export interface PlayingStyle {
  role: Player['role'];
  battingHand: 'R' | 'L';
  bowlingStyle?: string;
}

export interface MatchReduction {
  reason: 'rain' | 'badLight' | 'lateStart' | 'other';
  /** Playing time lost, in minutes, across every stoppage so far. */
  minutesLost: number;
  overs: [number, number];
  /** Set once the first innings is over and the chase has fewer overs. */
  target?: number;
  rule: import('@/engine').RainRule;
  /** Too few overs left for a result. */
  noResult?: boolean;
  text: string;
  at: ISODate;
}

export interface RatingSummary {
  role: import('@/engine').RatedRole;
  count: number;
  /** 1 to 5. */
  average: number;
  aspects: Record<string, number>;
  /** `matchLabel`: the match it was for; overall ratings have none. */
  recent: { by: string; comment?: string; at: ISODate; average: number; matchLabel?: string }[];
  /** How many were for a match, and how many overall. */
  byMatch: number;
  overall: number;
}

export interface RatingInput {
  role: import('@/engine').RatedRole;
  matchId?: ID;
  /** Aspect key to 1..5, from RATING_ASPECTS. */
  scores: Record<string, number>;
  comment?: string;
}

/** An invitation to score or umpire one match. */
/** Someone for a match role: an Ovalcast account (invited, listed once they accept), or just a name. */
export type OfficialPick = { userId: ID; name?: string } | { userId?: undefined; name: string };

/** Everything an organiser sets before a match. Each field left out stays as it is. */
export interface MatchSetupInput {
  startsAt?: ISODate;
  venue?: string;
  /** Which side is at home (before the toss). */
  homeTeamId?: ID;
  /** The scorer needs an account, to score on their phone. null takes the scorer off. */
  scorer?: { userId: ID } | null;
  /** The whole list wanted: up to two umpires, up to two groundsmen. */
  umpires?: OfficialPick[];
  groundsmen?: OfficialPick[];
  /** Added to every invitation sent. */
  note?: string;
}

export interface OfficialInvite {
  id: ID;
  matchId: ID;
  userId: ID;
  userName: string;
  role: 'scorer' | 'umpire' | 'groundsman';
  invitedBy: ID;
  invitedByName: string;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  note?: string;
  createdAt: ISODate;
}

export type DeductionReason = 'lateStart' | 'ineligiblePlayer' | 'slowOverRate' | 'misconduct' | 'unpaidFees' | 'forfeit' | 'other';

/** Points the league takes off a club. Subtracted from the table while active. */
export interface PointDeduction {
  id: ID;
  competitionId: ID;
  teamId: ID;
  points: number;
  reason: DeductionReason;
  note: string;
  matchId?: ID;
  status: 'active' | 'revoked';
  by: ID;
  byName: string;
  at: ISODate;
  revokedAt?: ISODate;
}

export interface AppNotification {
  id: ID;
  /** Whose notification this is. */
  userId: ID;
  kind: 'entry' | 'transfer' | 'match' | 'result' | 'invite' | 'payment' | 'community' | 'official' | 'discipline';
  title: string;
  body: string;
  at: ISODate;
  read: boolean;
  /** Where tapping it goes. */
  link?: { pathname: string; params?: Record<string, string> };
}

export interface SearchResults {
  players: Player[];
  teams: Team[];
  competitions: Competition[];
}

/** What a story is about. */
export type StoryKind = 'highlight' | 'training' | 'matchday' | 'news' | 'milestone';

/** A post on the feed: a training session, a match highlight, matchday news or a milestone, with photos. */
export interface Story {
  id: ID;
  authorId: ID;
  authorName: string;
  kind: StoryKind;
  text: string;
  photoUrls: string[];
  /** What it's tagged with, so it shows on that club's, match's or league's page too. */
  teamId?: ID;
  matchId?: ID;
  competitionId?: ID;
  likes: number;
  comments: number;
  /** The viewer liked it. */
  liked: boolean;
  /** The viewer may delete it: the author, an admin of the tagged club or league, or staff. */
  canDelete: boolean;
  createdAt: ISODate;
}

export interface StoryComment {
  id: ID;
  storyId: ID;
  authorId: ID;
  authorName: string;
  text: string;
  createdAt: ISODate;
}

export interface StoryInput {
  kind: StoryKind;
  text: string;
  /** Up to four, each from uploadStoryPhoto. */
  photoUrls?: string[];
  teamId?: ID;
  matchId?: ID;
  competitionId?: ID;
}

export type PostKind = 'clubWantsPlayers' | 'playerWantsClub' | 'friendlyWanted' | 'needUmpire' | 'needScorer' | 'groundAvailable';

/** The community board: lightweight "looking for" posts, answered on WhatsApp. */
export interface CommunityPost {
  id: ID;
  kind: PostKind;
  regionId: ID;
  title: string;
  body: string;
  authorName: string;
  teamId?: ID;
  /** A WhatsApp number in international form, for a wa.me link. */
  whatsapp: string;
  when?: ISODate;
  createdAt: ISODate;
}

export interface FriendlyInput {
  /** 'me': the creator scores. Otherwise invite this user; until they accept, the creator can still score. */
  scorer?: 'me' | { inviteUserId: ID };
  home: { teamId?: ID; name?: string };
  away: { teamId?: ID; name?: string };
  venue: string;
  startsAt: ISODate;
  oversPerInnings: number;
  ballType: 'leather' | 'tennis';
  /** A practice match at training: two sides picked from one club's squad. `home` and `away` are ignored. */
  practice?: { teamId: ID; sides: [string, string] };
}

export interface Standings {
  competitionId: ID;
  stageId: ID;
  groups: { groupId: ID; name: string; rows: import('@/engine').StandingRow[] }[];
}

export interface LeaderboardEntry {
  playerId: ID;
  teamId: ID;
  value: number;
  detail: string;
}

export interface Leaderboards {
  runs: LeaderboardEntry[];
  wickets: LeaderboardEntry[];
  sixes: LeaderboardEntry[];
  strikeRate: LeaderboardEntry[];
  economy: LeaderboardEntry[];
}

/**
 * A club's place in a competition. Either side can start it: the league invites
 * a club (`invite`), or a club asks to join (`request`). The other side answers.
 */
export interface CompetitionEntry {
  id: ID;
  competitionId: ID;
  teamId: ID;
  kind: 'invite' | 'request';
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  message?: string;
  createdAt: ISODate;
  respondedAt?: ISODate;
  /** Set once the entry fee is paid or marked paid. */
  payment?: Payment;
}

export interface PlayerInvite {
  id: ID;
  teamId: ID;
  name: string;
  channel: 'whatsapp' | 'sms' | 'email';
  contact: string;
  status: 'pending' | 'joined' | 'cancelled';
  createdAt: ISODate;
}

export interface CreateTeamInput {
  name: string;
  shortName: string;
  colors: [string, string];
  homeGround: string;
  city: string;
  founded?: number;
}

export interface CreateCompetitionInput {
  orgId: ID;
  /** The next edition of an earlier tournament of this organisation, so the years link up. */
  continues?: ID;
  category?: CompetitionCategory;
  /** Division level for promotion and relegation: 1 is the top. */
  rainRule?: import('@/engine').RainRule;
  tier?: number;
  name: string;
  season: string;
  format: Competition['format'];
  ballType: Competition['ballType'];
  oversPerInnings: number;
  structure: 'league' | 'groupsThenKnockout' | 'knockout';
  doubleRound: boolean;
  groups: number;
  qualifyPerGroup: number;
  points: Competition['points'];
  entryPolicy: Competition['entryPolicy'];
  entryFee: number;
  maxTeams: number;
  startsOn: ISODate;
  playerRules: PlayerRules;
}

export interface Stream {
  id: ID;
  matchId: ID;
  status: 'live' | 'ended' | 'scheduled';
  /** HLS playback URL from the video service (Cloudflare Stream or Mux). */
  playbackUrl: string;
  viewers: number;
  /** Measured glass-to-glass delay. The overlay is held back by this much. */
  latencySeconds: number;
  source: 'phone' | 'encoder';
  streamer: string;
  /** Seconds the picture reached viewers, and seconds it was down. */
  liveSeconds?: number;
  downSeconds?: number;
  /** Passes were refunded automatically: the stream was down for over 30% of it. */
  refunded?: boolean;
}

/** A paid stream: fans buy a pass for the match (there are no season passes for streams). */
export interface PassOffer {
  matchId: ID;
  price: number;
  currency: Currency;
  hostUserId: ID;
  hostName: string;
  /** The signed-in viewer's pass, if they have one. */
  mine?: MatchPass;
}

export interface MatchPass {
  id: ID;
  userId: ID;
  /** A single match, or a whole competition for a season pass. */
  matchId?: ID;
  competitionId?: ID;
  price: number;
  currency: Currency;
  paidWith: Payment['method'] | 'wallet';
  status: 'active' | 'refunded';
  at: ISODate;
}

/** What the signed-in user's plan allows and how much of it they have used. Unlimited is null. */
export interface PlanStatus {
  plan: import('@/engine').PlanId;
  subscription?: Subscription;
  limits: { activeLeagues: number | null; teamsPerLeague: number | null; matchesPerMonth: number | null };
  usage: { activeLeagues: number; matchesThisMonth: number };
  /** What Pro costs this user: naira in Nigeria, dollars elsewhere. */
  proPrice: { currency: import('@/engine').PriceCurrency; monthly: number; yearly: number };
  /** Leagues this user runs under an organisation's contract instead of their own plan. */
  organisationPlans: { orgId: ID; name: string }[];
}

export interface Subscription {
  id: ID;
  plan: 'pro';
  interval: import('@/engine').BillingInterval;
  status: 'active' | 'pastDue' | 'cancelled';
  currency: import('@/engine').PriceCurrency;
  amount: number;
  startedAt: ISODate;
  renewsAt: ISODate;
  /** Cancelled subscriptions keep Pro until the period ends. */
  cancelAtPeriodEnd: boolean;
  /** Bought on the web through Flutterwave, or inside an app store. */
  provider: 'flutterwave' | 'appStore' | 'playStore';
}

/** Fans top up once and pay for passes without a payment fee each time. In the currency of the country they play in. */
export interface Wallet {
  balance: number;
  currency: Currency;
  entries: { id: ID; kind: 'topUp' | 'pass' | 'refund'; amount: number; note: string; reference: string; at: ISODate }[];
}

/** Ovalcast's shares, as staff set them: 0.25 = 25%. Organisations and streamers listed have their own. */
export interface StaffShares {
  /** Of a paid stream's takings after the payment fee; the streamer keeps the rest. */
  platformShare: number;
  /** Of league entry fees paid online. */
  entryShare: number;
  updatedAt?: ISODate;
  updatedBy?: ID;
  organisations: { orgId: ID; name: string; platformShare?: number; entryShare?: number }[];
  streamers: { userId: ID; name: string; platformShare: number }[];
}

/** A host's share of pass sales and their weekly payouts. */
export interface HostEarnings {
  currency: Currency;
  /** 0.7, or 0.75 for hosts averaging more than 500 paying viewers over their last 5 matches. */
  share: number;
  balance: number;
  minimumPayout: number;
  nextPayoutOn: ISODate;
  matches: { matchId: ID; passes: number; gross: number; fees: number; host: number; at: ISODate }[];
  payouts: { id: ID; amount: number; status: 'processing' | 'paid'; reference: string; at: ISODate }[];
}

/** Viewer-hours an organisation has bought so fans watch its matches free in the Ovalcast player. */
export interface ViewerCredits {
  orgId: ID;
  hoursLeft: number;
  hoursUsed: number;
  purchases: { id: ID; hours: number; price: number; reference: string; at: ISODate }[];
}

/** A payment that has either gone through, or needs the payer to finish on Flutterwave's page. */
export interface CheckoutResult {
  status: 'paid' | 'redirect';
  reference: string;
  /** Flutterwave's hosted checkout, when status is redirect. */
  link?: string;
}

/** A payment as it stands, for the page Flutterwave sends payers back to. */
export interface PaymentStatus {
  reference: string;
  status: 'pending' | 'paid' | 'failed';
  kind: 'entry' | 'pro' | 'topUp' | 'pass' | 'credits';
  amount: number;
  currency: string;
  /** What it paid for: the entry, match or organisation. */
  refId?: ID;
}

/** A code the scorer reads out so another phone can take over scoring. */
export interface HandoverCode {
  matchId: ID;
  code: string;
  expiresAt: ISODate;
}

export interface RulesDocumentVersion {
  version: number;
  name: string;
  sizeKb: number;
  uploadedAt: ISODate;
  uploadedByName: string;
  fileUrl: string;
}

/** A player asking for matches scored under a typed-in name to count as theirs. The club admin decides. */
export interface PlayerClaim {
  id: ID;
  /** The typed-in or guest player record being claimed. */
  playerId: ID;
  playerName: string;
  teamId: ID;
  userId: ID;
  userName: string;
  status: 'pending' | 'approved' | 'rejected';
  note?: string;
  createdAt: ISODate;
  respondedAt?: ISODate;
}

export interface PlayerMilestones {
  playerId: ID;
  earned: import('@/engine').Milestone[];
  next: import('@/engine').Milestone[];
}

/** What a streamer needs to go live: the ingest address for the phone or OBS, and the overlay for OBS. */
export interface LiveSetup {
  stream: Stream;
  ingest: { protocol: 'rtmps' | 'srt'; url: string; streamKey: string };
  /** Add as a browser source in OBS or vMix. */
  overlayUrl: string;
  /** Paid streams are never restreamed free to YouTube. */
  youtube: 'restreaming' | 'notConnected' | 'blockedPaid';
}

/** A partner key issued by Ovalcast to an Organisation-plan customer. The key itself is shown once, at issue. */
export interface ApiClientSummary {
  id: ID;
  name: string;
  keyPrefix: string;
  sandbox: boolean;
  createdAt: ISODate;
  lastUsedAt?: ISODate;
  revokedAt?: ISODate;
  requestsThisMonth: number;
  webhooks: { id: ID; url: string; events: string[]; active: boolean }[];
}

/** An admin of an organisation or a club. */
export interface AdminMember {
  userId: ID;
  name: string;
  role: 'owner' | 'leagueAdmin' | 'clubAdmin';
  contact?: string;
}

/** Every way a match can end without being played out. */
export type MatchDecisionKind = 'postponed' | 'cancelled' | 'noResult' | 'abandoned' | 'walkover' | 'doubleForfeit' | 'conceded' | 'awarded';

/** Why one side forfeited, or why the league stepped in. */
export type DecisionReason = 'weather' | 'groundUnfit' | 'noShow' | 'notEnoughPlayers' | 'lateArrival' | 'refusedToPlay' | 'ineligiblePlayer' | 'misconduct' | 'safety' | 'other';

export interface MatchDecisionInput {
  kind: MatchDecisionKind;
  /** The side that gets the win (walkover, conceded, awarded), or goes through in a knockout called off. */
  winnerTeamId?: ID;
  reason?: DecisionReason;
  note: string;
  /** Points taken off the side at fault, on top of losing (walkovers). */
  penaltyPoints?: number;
}

export interface MatchDecision extends MatchDecisionInput {
  decidedByName: string;
  at: ISODate;
  /** The result before the league awarded it the other way. */
  previousResult?: string;
}

/** A club asking the league to move a fixture. */
export interface FixtureRequest {
  id: ID;
  matchId: ID;
  teamId: ID;
  requestedByName: string;
  startsAt?: ISODate;
  venue?: string;
  note: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: ISODate;
}

/** Next season's divisions, worked out from this season's tables. The admin adjusts and confirms. */
export interface SeasonProposal {
  orgId: ID;
  fromSeason: string;
  toSeason: string;
  movesPerDivision: number;
  divisions: { competitionId: ID; name: string; tier: number; teamIds: ID[]; promoted: ID[]; relegated: ID[]; unfinished: boolean }[];
}

// ---------------------------------------------------------------- backoffice (Ovalcast staff)

/** Money in one currency. Amounts are in the currency's main unit (naira, cedi, pounds). */
export interface StreamingTotals {
  currency: string;
  /** Passes sold, including any later refunded. */
  passes: number;
  gross: number;
  refunded: number;
  /** Payment provider fees on what wasn't refunded. */
  fees: number;
  /** The streamers' share. */
  hosts: number;
  /** What Ovalcast keeps. */
  ovalcast: number;
}

export interface StaffOverview {
  days: number;
  users: { total: number; new: number; active: number; activeToday: number; suspended: number; locked: number };
  cricket: { liveMatches: number; matchesPlayed: number; balls: number; liveStreams: number; streamHours: number; stories: number };
  streaming: StreamingTotals[];
  viewerCredits: { currency: string; amount: number; hours: number; count: number }[];
  /** Other money in, by kind: entry fees, Pro, wallet top-ups. */
  payments: { kind: 'entry' | 'pro' | 'topUp' | 'credits'; currency: string; amount: number; count: number }[];
  failedPayments: number;
  hostPayouts: { currency: string; paid: number; owed: number }[];
  /** Pass sales per day, oldest first. */
  daily: { day: string; currency: string; gross: number; ovalcast: number; passes: number }[];
}

export type StaffUserFilter = 'all' | 'new' | 'active' | 'suspended' | 'locked' | 'staff' | 'unverified';

export interface StaffUserRow {
  id: ID;
  name: string;
  email?: string;
  phone?: string;
  verified: boolean;
  city?: string;
  country?: string;
  createdAt: ISODate;
  lastSeenAt?: ISODate;
  staff: boolean;
  suspended: boolean;
  lockedUntil?: ISODate;
  /** League admin, club admin, scorer, umpire and so on. */
  roles: string[];
}

export interface StaffActionRow {
  id: ID;
  at: ISODate;
  staffName: string;
  action: string;
  targetKind: string;
  targetId?: ID;
  targetLabel?: string;
  note?: string;
}

export type ActivityKind = 'signup' | 'signin' | 'pass' | 'payment' | 'paymentFailed' | 'refund' | 'payout' | 'matchStarted' | 'story' | 'entry' | 'staff';

export interface ActivityItem {
  id: string;
  at: ISODate;
  kind: ActivityKind;
  text: string;
  userId?: ID;
  userName?: string;
  amount?: number;
  currency?: string;
  /** Where to look: a website path. */
  href?: string;
}

export interface StaffUserDetail {
  user: StaffUserRow & { suspendedAt?: ISODate; suspendedReason?: string; deleteOn?: ISODate; failedLogins: number };
  memberships: { role: string; name: string; href?: string }[];
  sessions: { active: number; lastSignIn?: ISODate };
  wallet?: { balance: number; currency?: string };
  passes: { id: ID; at: ISODate; matchId?: ID; label: string; price: number; currency: string; paidWith: string; status: string }[];
  payments: { id: ID; at: ISODate; kind: string; amount: number; currency: string; status: string; method: string }[];
  /** As a streamer selling passes. */
  hosting?: { matches: number; passes: number; gross: number; earned: number; paidOut: number; currency: string };
  counts: { scored: number; umpired: number; stories: number; ratingsGiven: number };
  actions: StaffActionRow[];
  activity: ActivityItem[];
}

export interface StreamingMoney {
  days: number;
  totals: StreamingTotals[];
  matches: { matchId: ID; label: string; date: ISODate; hostUserId: ID; hostName: string; currency: string; passes: number; gross: number; refunded: number; fees: number; host: number; ovalcast: number; liveMinutes: number; streamRefunded: boolean }[];
  hosts: { userId: ID; name: string; currency: string; passes: number; gross: number; earned: number; paidOut: number }[];
  /** Each sale as it divided: the payment fee, Ovalcast's platform share and the streamer's share, and the rate used (none on sales from before rates were recorded). */
  passes: { id: ID; at: ISODate; userId: ID; userName: string; matchId?: ID; label: string; price: number; currency: string; paidWith: string; status: string; fee: number; platform: number; streamer: number; platformShare?: number }[];
  viewerCredits: { id: ID; at: ISODate; orgId: ID; orgName: string; hours: number; price: number; currency: string }[];
  payouts: { id: ID; at: ISODate; userId: ID; userName: string; amount: number; currency: string; status: string; reference: string }[];
}

/** For Ovalcast staff: a client organisation at a glance. */
export interface StaffOrgSummary {
  org: Organisation;
  admins: number;
  competitions: number;
  matchesThisMonth: number;
  apiKeys: number;
  /** Website embeds: asked for, switched on, or neither. */
  embeds: EmbedStatus;
  embedsRequestedAt?: ISODate;
}

/** Website embeds: an organisation's tables, fixtures, results and live scores on its own site, in an iframe. */
export type EmbedStatus = 'off' | 'requested' | 'approved';
export interface EmbedSettings {
  orgId: ID;
  status: EmbedStatus;
  requestedAt?: ISODate;
  approvedAt?: ISODate;
  /** The organisation's websites the embeds may appear on: ccclagos.com, or *.ccclagos.com for every subdomain. */
  domains: string[];
}
/** For the website's server: whether embeds for this organisation (or a competition's) may show, and where. */
export interface EmbedAccess {
  orgId: ID;
  orgName: string;
  approved: boolean;
  domains: string[];
}

export interface PendingCertificate {
  certificate: Certificate;
  userId: ID;
  userName: string;
}

/** Shown once, when Ovalcast staff issue a key. */
export interface IssuedApiKey {
  client: ApiClientSummary;
  key: string;
}

/** A player's invitation link, as the invited person sees it. */
export interface InviteView {
  invite: PlayerInvite;
  team: Team;
}

export interface Clip {
  id: ID;
  matchId: ID;
  ballEventId: ID;
  kind: 'four' | 'six' | 'wicket';
  title: string;
  over: string;
  durationSeconds: number;
}

export interface TossSession {
  matchId: ID;
  code: string;
  callerTeamId: ID;
  call?: 'heads' | 'tails';
  outcome?: 'heads' | 'tails';
  wonByTeamId?: ID;
  decision?: 'bat' | 'bowl';
  at?: ISODate;
}

export interface MatchStartInput {
  battingFirstTeamId: ID;
  playingXI: Record<ID, ID[]>;
  openers: [ID, ID];
  openingBowlerId: ID;
  leaders?: Record<ID, { captainId?: ID; keeperId?: ID }>;
}

/** The XI a club submits before a match, with reserves, captain and wicketkeeper. */
export interface TeamSheet {
  matchId: ID;
  teamId: ID;
  playerIds: ID[];
  reserves: ID[];
  captainId?: ID;
  keeperId?: ID;
  submittedBy: ID;
  submittedByName: string;
  submittedAt: ISODate;
}

/** What the scorer starts from for each side: the club's team sheet, else its last XI, else the squad. */
export interface MatchLineups {
  matchId: ID;
  teams: Record<ID, {
    sheet?: TeamSheet;
    suggested: ID[];
    captainId?: ID;
    keeperId?: ID;
    source: 'teamSheet' | 'lastMatch' | 'squad';
    lastMatch?: { matchId: ID; date: ISODate; opponentId: ID };
  }>;
}

export interface PlayerShotProfile {
  playerId: ID;
  leftHanded: boolean;
  batting?: import('@/engine').ShotProfile;
  bowling?: import('@/engine').BowlingShotProfile;
}

/** Messages on the live feed (server-sent events in production). */
export type LiveMessage =
  | { type: 'ball'; event: BallEvent }
  | { type: 'void'; event: BallEvent }
  | { type: 'status'; match: Match };

export type BallEventInput = Omit<BallEvent, 'id' | 'createdAt' | 'createdBy' | 'matchId'>;

export interface OvalcastApi {
  readonly mode: 'mock' | 'http';

  // POST /auth/sign-up  (sends a code to the email or phone)
  signUp(input: SignUpInput): Promise<{ identifier: string; code: CodeSent }>;
  // POST /auth/sign-in  (identifier is an email or an international phone number)
  signIn(identifier: string, password: string): Promise<SignInResult>;
  // POST /auth/code  (purpose: verify a contact, or reset the password)
  requestCode(identifier: string, purpose: 'verify' | 'reset'): Promise<CodeSent>;
  // POST /auth/verify
  verifyCode(identifier: string, code: string): Promise<AuthSession>;
  // POST /auth/reset-password
  resetPassword(identifier: string, code: string, newPassword: string): Promise<AuthSession>;
  // GET /auth/session  (Authorization: Bearer token)
  restoreSession(token: string): Promise<AuthSession>;
  // POST /auth/sign-out
  signOut(token: string): Promise<void>;
  // POST /me/contacts  (add or re-verify an email or phone for the signed-in user; then verifyCode)
  addContact(value: string): Promise<{ identifier: string; code: CodeSent }>;

  // GET /me
  getMe(): Promise<User>;

  // GET /organisations/:id
  getOrganisation(id: ID): Promise<Organisation>;

  // GET /competitions?orgId=&status=
  listCompetitions(params?: { orgId?: ID; status?: Competition['status'] }): Promise<Competition[]>;
  // GET /organisations
  listOrganisations(): Promise<Organisation[]>;
  // GET /competitions/:id
  getCompetition(id: ID): Promise<Competition>;
  // GET /competitions/:id/standings?stageId=
  getStandings(competitionId: ID, stageId?: ID): Promise<Standings>;
  // GET /competitions/:id/leaderboards
  getLeaderboards(competitionId: ID): Promise<Leaderboards>;

  // GET /teams?orgId= , GET /teams/:id , GET /teams/:id/players
  listTeams(params?: { orgId?: ID }): Promise<Team[]>;
  getTeam(id: ID): Promise<Team>;
  listPlayers(teamId: ID): Promise<Player[]>;
  // GET /players/:id/career
  getPlayerCareer(playerId: ID): Promise<PlayerCareer>;

  // GET /matches?status=&competitionId=&teamId=
  listMatches(params?: { status?: MatchStatus[]; competitionId?: ID; teamId?: ID }): Promise<Match[]>;
  // GET /matches/:id
  getMatch(id: ID): Promise<Match>;
  // POST /matches/:id/start   (assigned scorer only)
  startMatch(id: ID, input: MatchStartInput): Promise<Match>;
  // POST /matches/:id/lock    (league admin or both captains)
  lockMatch(id: ID): Promise<Match>;

  // GET /matches/:id/balls
  listBallEvents(matchId: ID): Promise<BallEvent[]>;
  // POST /matches/:id/balls   (assigned scorer only; de-duplicated by clientId)
  postBallEvent(matchId: ID, input: BallEventInput): Promise<BallEvent>;
  // POST /matches/:id/balls/:eventId/void
  voidBallEvent(matchId: ID, eventId: ID, clientId: string): Promise<BallEvent>;

  // GET /matches/:id/live?balls=<n>&since=<ms>   (server-sent events)
  /** `have`: what the viewer already shows (how many balls, and when the match was read); anything newer comes first. */
  subscribeMatch(matchId: ID, onMessage: (m: LiveMessage) => void, have?: { balls?: number; since?: number }): () => void;

  // POST /matches/:id/toss , POST /matches/:id/toss/call , POST /matches/:id/toss/decision
  createToss(matchId: ID): Promise<TossSession>;
  callToss(matchId: ID, call: 'heads' | 'tails'): Promise<TossSession>;
  chooseTossDecision(matchId: ID, decision: 'bat' | 'bowl'): Promise<TossSession>;

  // POST /teams  (the creator becomes the club admin)
  createTeam(input: CreateTeamInput): Promise<Team>;
  // GET /teams/:id/invites , POST /teams/:id/invites , POST /invites/:id/cancel
  listPlayerInvites(teamId: ID): Promise<PlayerInvite[]>;
  invitePlayer(teamId: ID, input: Pick<PlayerInvite, 'name' | 'channel' | 'contact'>): Promise<PlayerInvite>;
  cancelPlayerInvite(inviteId: ID): Promise<PlayerInvite>;

  // POST /competitions  (league admin of input.orgId)
  createCompetition(input: CreateCompetitionInput): Promise<Competition>;
  // GET /entries?competitionId=&teamId=
  listEntries(params: { competitionId?: ID; teamId?: ID }): Promise<CompetitionEntry[]>;
  // POST /competitions/:id/invites  (league admin invites a club)
  inviteTeam(competitionId: ID, teamId: ID, message?: string): Promise<CompetitionEntry>;
  // POST /competitions/:id/requests  (club admin asks to join)
  requestToJoin(competitionId: ID, teamId: ID, message?: string): Promise<CompetitionEntry>;
  // POST /entries/:id/respond  (the other side accepts or declines; the sender may withdraw)
  respondToEntry(entryId: ID, response: 'accept' | 'decline' | 'withdraw'): Promise<CompetitionEntry>;
  // POST /competitions/:id/fixtures  (league admin; closes entries and builds the fixtures)
  generateFixtures(competitionId: ID): Promise<Match[]>;

  // GET /regions , GET /regions/nearest?lat=&lon=
  listRegions(): Promise<Region[]>;
  nearestRegion(lat: number, lon: number): Promise<Region>;
  // GET /regions/:id/leaders
  getRegionalLeaders(regionId: ID): Promise<RegionalLeaders>;

  // GET /registrations?competitionId=&playerId=&teamId=
  listRegistrations(params: { competitionId?: ID; playerId?: ID; teamId?: ID }): Promise<Registration[]>;
  // GET /transfers?competitionId=&playerId=
  listTransfers(params: { competitionId?: ID; playerId?: ID }): Promise<Transfer[]>;
  // POST /transfers  (the club admin of toTeamId asks for the player, or the player asks to join toTeamId)
  requestTransfer(input: { competitionId: ID; playerId: ID; fromTeamId: ID; toTeamId: ID; kind: Transfer['kind']; note?: string }): Promise<Transfer>;
  // POST /transfers/:id/respond  (the player or the club asked, then the releasing club, then the league admin; whoever asked may withdraw)
  respondToTransfer(transferId: ID, response: 'approve' | 'reject' | 'withdraw' | 'dispute', note?: string): Promise<Transfer>;
  // POST /registrations/:id/end  (ends a second club: the player, either club, or a league admin)
  endRegistration(registrationId: ID, note?: string): Promise<Registration>;

  // PATCH /me
  updateMe(patch: Partial<Pick<User, 'name' | 'phone' | 'city' | 'settings'>>): Promise<User>;
  // GET /notifications , POST /notifications/read
  listNotifications(): Promise<AppNotification[]>;
  markNotificationsRead(): Promise<void>;
  // GET /search?q=
  search(q: string): Promise<SearchResults>;

  // PATCH /teams/:id , POST /teams/:id/logo (multipart in production)
  updateTeam(teamId: ID, patch: Partial<Pick<Team, 'name' | 'shortName' | 'colors' | 'homeGround' | 'city'>>): Promise<Team>;
  uploadTeamLogo(teamId: ID, fileUri: string): Promise<Team>;
  // POST /teams/:id/staff , DELETE /teams/:id/staff/:staffId
  addStaff(teamId: ID, input: Omit<StaffMember, 'id'>): Promise<Team>;
  removeStaff(teamId: ID, staffId: ID): Promise<Team>;

  // POST /matches  (a friendly; the creator is its scorer)
  createFriendly(input: FriendlyInput): Promise<Match>;
  // GET /matches/:id/eligibility
  getMatchEligibility(matchId: ID): Promise<MatchEligibility>;
  // POST /matches/:id/guests  (a guest player for one match, within the league's limit)
  addGuestPlayer(matchId: ID, teamId: ID, name: string): Promise<Player>;
  // POST /teams/:id/players  (club admin, or an admin of a league the team plays in: players by name, no accounts needed)
  addPlayersToSquad(teamId: ID, names: string[]): Promise<Player[]>;
  // POST /competitions/:id/teams  (league admin: a team typed in by name, with any players, entered straight away; the admin runs it until they hand it on)
  addTeamByName(competitionId: ID, input: { name: string; players?: string[] }): Promise<Team>;
  // POST /competitions/:id/knockouts  (league admin; seeds the bracket from the table, or draws a straight knockout)
  generateKnockouts(competitionId: ID): Promise<Match[]>;

  // POST /entries/:id/pay  (club admin; Flutterwave checkout in production) , POST /entries/:id/mark-paid (league admin, cash)
  payEntry(entryId: ID, method: Payment['method']): Promise<CheckoutResult>;
  markEntryPaid(entryId: ID): Promise<CompetitionEntry>;
  // POST /entries/:id/remind  (league admin; tells the club's admins the fee is due)
  remindEntryFee(entryId: ID): Promise<void>;

  // League money, for league admins.
  // GET /organisations/:id/finance
  getLeagueFinance(orgId: ID): Promise<LeagueFinance>;
  // GET /payouts/institutions?country= , POST /payouts/resolve  (asks the bank or network for the name on the account)
  listPayoutInstitutions(country: string): Promise<PayoutInstitution[]>;
  resolvePayoutAccount(input: { country: string; kind: 'bank' | 'mobileMoney'; institutionCode: string; accountNumber: string }): Promise<{ accountName: string }>;
  // PUT /organisations/:id/payout-account
  setPayoutAccount(orgId: ID, input: PayoutAccountInput): Promise<PayoutAccount>;
  // POST /organisations/:id/withdrawals  (manual schedule: pays everything the provider is holding)
  withdrawLeagueFunds(orgId: ID): Promise<Settlement>;

  // GET /community?regionId= , POST /community
  listPosts(regionId: ID): Promise<CommunityPost[]>;
  createPost(input: Omit<CommunityPost, 'id' | 'createdAt' | 'authorName'>): Promise<CommunityPost>;

  // GET /people/:id , PATCH /me/officiating
  getPerson(userId: ID): Promise<PersonProfile>;
  updateOfficiating(patch: Partial<Omit<OfficiatingProfile, 'certificates'>>): Promise<PersonProfile>;
  // POST /me/certificates (multipart) , DELETE /me/certificates/:id
  uploadCertificate(input: Omit<Certificate, 'id' | 'status' | 'uploadedAt' | 'fileUrl'> & { fileUri: string }): Promise<PersonProfile>;
  removeCertificate(certificateId: ID): Promise<PersonProfile>;
  // GET /officials?regionId=&role=&availableOnly=&date=YYYY-MM-DD&minRating=
  // date: only officials free that day (open to invites, free that weekday, not away, not already
  // appointed to a match that day). minRating: at least this average (1 to 5) for the role.
  listOfficials(params: { regionId?: ID; role?: OfficialRole; availableOnly?: boolean; date?: string; minRating?: number }): Promise<PersonProfile[]>;

  // POST /matches/:id/officials/invite , GET /matches/:id/officials/invites , GET /me/official-invites , POST /official-invites/:id/respond
  inviteOfficial(matchId: ID, userId: ID, role: 'scorer' | 'umpire' | 'groundsman', note?: string): Promise<OfficialInvite>;
  // POST /matches/:id/setup  (organisers: the ground, date, home side and every official at once)
  setUpMatch(matchId: ID, input: MatchSetupInput): Promise<{ match: Match; invites: OfficialInvite[] }>;
  listMatchOfficialInvites(matchId: ID): Promise<OfficialInvite[]>;
  listMyOfficialInvites(): Promise<OfficialInvite[]>;
  respondToOfficialInvite(inviteId: ID, response: 'accept' | 'decline' | 'withdraw'): Promise<OfficialInvite>;

  // GET /competitions/:id/deductions , POST /competitions/:id/deductions , POST /deductions/:id/revoke
  listDeductions(competitionId: ID): Promise<PointDeduction[]>;
  deductPoints(competitionId: ID, input: { teamId: ID; points: number; reason: DeductionReason; note: string; matchId?: ID }): Promise<PointDeduction>;
  revokeDeduction(deductionId: ID): Promise<PointDeduction>;

  // Plans. GET /me/plan , POST /me/subscription , DELETE /me/subscription (cancels at the period's end)
  getPlan(): Promise<PlanStatus>;
  subscribePro(interval: import('@/engine').BillingInterval, method: Payment['method']): Promise<CheckoutResult>;
  cancelPro(): Promise<Subscription>;

  // Wallet. GET /me/wallet , POST /me/wallet/top-ups
  getWallet(): Promise<Wallet>;
  topUpWallet(amount: number, method: Payment['method']): Promise<CheckoutResult>;

  // Paid streams. GET /matches/:id/pass-offer (null when free) , PUT /matches/:id/pass-offer (host) , POST /matches/:id/passes
  getPassOffer(matchId: ID): Promise<PassOffer | null>;
  setPassPrice(matchId: ID, price: number | null): Promise<PassOffer | null>;
  buyPass(matchId: ID, input: { paidWith: Payment['method'] | 'wallet' }): Promise<CheckoutResult>;
  // GET /payments/:reference: one of your own payments, after Flutterwave sends you back.
  getPayment(reference: string): Promise<PaymentStatus>;

  // Hosts. GET /me/earnings
  getHostEarnings(): Promise<HostEarnings>;

  // Viewer credits. GET /organisations/:id/viewer-credits , POST /organisations/:id/viewer-credits
  getViewerCredits(orgId: ID): Promise<ViewerCredits>;
  buyViewerCredits(orgId: ID, packs: number, method: Payment['method']): Promise<CheckoutResult>;

  // Scoring on one phone at a time. POST /matches/:id/handover (scorer) , POST /matches/:id/handover/claim , POST /matches/:id/scorer (league admin)
  createHandoverCode(matchId: ID): Promise<HandoverCode>;
  claimHandover(matchId: ID, code: string): Promise<Match>;
  reassignScorer(matchId: ID, userId: ID): Promise<Match>;
  // POST /matches/:id/stoppages  (the scorer or the organiser: time lost to rain, bad light or a late start; overs and target are worked out)
  reportStoppage(matchId: ID, input: { minutesLost: number; reason: MatchReduction['reason'] }): Promise<Match>;
  // PATCH /me/playing  (how you play: batter, bowler, keeper or all-rounder)
  updateMyPlaying(input: PlayingStyle): Promise<User>;
  // POST /people/:id/ratings  (someone who worked a match with them; one rating per match and role)
  rateOfficial(userId: ID, input: RatingInput): Promise<PersonProfile>;
  // GET /feature-access (public) , PUT /staff/feature-access (staff): which features need a paid plan. Everything is free at launch.
  getFeatureAccess(): Promise<import('@/engine').FeatureAccess>;
  // GET /organisations/:id/series: each tournament with its yearly editions and how they compare.
  listSeries(orgId: ID): Promise<SeriesSummary[]>;
  // GET /shares: Ovalcast's current platform share of paid streams (after the payment fee) and share of entry fees, for pricing pages.
  getShares(): Promise<{ platformShare: number; entryShare: number }>;
  staffSetFeatureAccess(access: import('@/engine').FeatureAccess): Promise<import('@/engine').FeatureAccess>;
  // POST /matches/:id/score-myself  (a league admin, either club's admin, or a friendly's organiser takes the scoring, before anyone else has started)
  scoreMatchMyself(matchId: ID): Promise<Match>;

  // Rules documents. POST /competitions/:id/rules (multipart PDF or Word; Pro or Organisation) , GET /competitions/:id/rules
  uploadRulesDocument(competitionId: ID, file: { fileUri: string; name: string; sizeKb: number }): Promise<Competition>;
  listRulesVersions(competitionId: ID): Promise<RulesDocumentVersion[]>;

  // Claims. POST /players/:id/claims , GET /teams/:id/claims (club admin) , POST /claims/:id/respond
  claimPlayer(playerId: ID, note?: string): Promise<PlayerClaim>;
  listClaims(teamId: ID): Promise<PlayerClaim[]>;
  respondToClaim(claimId: ID, response: 'approve' | 'reject'): Promise<PlayerClaim>;

  // GET /players/:id/milestones
  getMilestones(playerId: ID): Promise<PlayerMilestones>;

  // Going live. POST /matches/:id/streams , POST /streams/:id/end , PUT /organisations/:id/youtube , PUT /teams/:id/youtube
  startStream(matchId: ID, source: Stream['source']): Promise<LiveSetup>;
  endStream(streamId: ID): Promise<Stream>;
  // POST /streams/:id/health  (the host's phone, every 30 seconds: seconds live and down since the stream began)
  reportStreamHealth(streamId: ID, health: { liveSeconds: number; downSeconds: number }): Promise<Stream>;
  setYouTubeKey(owner: { orgId: ID } | { teamId: ID }, streamKey: string | null): Promise<{ connected: boolean }>;

  // Partner API keys, issued by Ovalcast. GET /organisations/:id/api-clients , DELETE /organisations/:id/api-clients/:clientId
  listApiClients(orgId: ID): Promise<ApiClientSummary[]>;
  revokeApiClient(orgId: ID, clientId: ID): Promise<ApiClientSummary>;

  // Team sheets. GET /matches/:id/lineups , PUT /matches/:id/team-sheets/:teamId (that club's admin, before the start)
  getLineups(matchId: ID): Promise<MatchLineups>;
  submitTeamSheet(matchId: ID, teamId: ID, sheet: { playerIds: ID[]; reserves: ID[]; captainId?: ID; keeperId?: ID }): Promise<TeamSheet>;

  // GET /players/:id/shots
  getPlayerShots(playerId: ID): Promise<PlayerShotProfile>;

  // POST /organisations  (anyone can start one: a league, association, festival, school, academy or company; they become its owner)
  createOrganisation(input: CreateOrganisationInput): Promise<Organisation>;

  // Organisation and club admins. GET/POST /organisations/:id/admins , DELETE /organisations/:id/admins/:userId (owner) ; same under /teams/:id/admins
  listOrgAdmins(orgId: ID): Promise<AdminMember[]>;
  addOrgAdmin(orgId: ID, identifier: string): Promise<AdminMember[]>;
  removeOrgAdmin(orgId: ID, userId: ID): Promise<AdminMember[]>;
  listClubAdmins(teamId: ID): Promise<AdminMember[]>;
  addClubAdmin(teamId: ID, identifier: string): Promise<AdminMember[]>;
  removeClubAdmin(teamId: ID, userId: ID): Promise<AdminMember[]>;

  // Branding. PATCH /organisations/:id , POST /organisations/:id/images , POST /competitions/:id/images (multipart)
  updateOrganisation(orgId: ID, patch: Partial<Pick<Organisation, 'about' | 'sponsors' | 'brandColor' | 'executives'>>): Promise<Organisation>;
  uploadOrganisationImage(orgId: ID, kind: 'logo' | 'cover', fileUri: string): Promise<Organisation>;
  uploadCompetitionImage(competitionId: ID, kind: 'logo' | 'cover', fileUri: string): Promise<Competition>;

  // Fixtures. PATCH /matches/:id (league admin) , POST /matches/:id/outcome , POST /matches/:id/fixture-requests (club admin) , GET /competitions/:id/fixture-requests , POST /fixture-requests/:id/respond
  /** `swapSides`: the league makes the away side the home side (before the toss). */
  updateFixture(matchId: ID, patch: { startsAt?: ISODate; venue?: string; swapSides?: boolean }): Promise<Match>;
  setMatchOutcome(matchId: ID, input: MatchDecisionInput): Promise<Match>;
  requestFixtureChange(matchId: ID, input: { teamId: ID; startsAt?: ISODate; venue?: string; note: string }): Promise<FixtureRequest>;
  listFixtureRequests(competitionId: ID): Promise<FixtureRequest[]>;
  respondToFixtureRequest(requestId: ID, response: 'approve' | 'decline'): Promise<FixtureRequest>;

  // Squads. POST /competitions/:id/squads/:teamId/approve , POST /registrations/:id/reject
  approveSquad(competitionId: ID, teamId: ID, playerIds?: ID[]): Promise<Registration[]>;
  rejectRegistration(registrationId: ID): Promise<Registration>;

  // Player of the match. POST /matches/:id/player-of-match
  confirmPlayerOfMatch(matchId: ID, playerId: ID): Promise<Match>;

  // Joining a club from an invite link. GET /invites/:id , POST /invites/:id/accept
  getInvite(inviteId: ID): Promise<InviteView>;
  acceptInvite(inviteId: ID): Promise<{ team: Team; player: Player }>;

  // Following. POST /me/follows , DELETE /me/follows
  follow(kind: 'team' | 'player' | 'competition', id: ID): Promise<User>;
  unfollow(kind: 'team' | 'player' | 'competition', id: ID): Promise<User>;

  // Stories. GET /stories?teamId=&competitionId=&matchId=&authorId=&before= , POST /stories , DELETE /stories/:id ,
  // POST /stories/photos (multipart) , PUT /stories/:id/like , GET|POST /stories/:id/comments
  listStories(params?: { teamId?: ID; competitionId?: ID; matchId?: ID; authorId?: ID; before?: ISODate }): Promise<Story[]>;
  uploadStoryPhoto(fileUri: string): Promise<{ url: string }>;
  createStory(input: StoryInput): Promise<Story>;
  deleteStory(id: ID): Promise<void>;
  likeStory(id: ID, liked: boolean): Promise<Story>;
  listStoryComments(id: ID): Promise<StoryComment[]>;
  addStoryComment(id: ID, text: string): Promise<StoryComment>;

  // Seasons. GET /organisations/:id/season-proposal , POST /organisations/:id/season-proposal
  getSeasonProposal(orgId: ID, movesPerDivision?: number): Promise<SeasonProposal>;
  confirmSeasonProposal(orgId: ID, proposal: SeasonProposal): Promise<Competition[]>;

  // Safeguarding and data rights. PATCH /players/:id/guardian (club admin) , GET /me/export , POST /me/delete
  // PATCH /players/:id/guardian (club admin): under 18 and consent, and the date of birth (never public; setting it decides under 18).
  setPlayerMinor(playerId: ID, input: { minor?: boolean; guardianConsent?: boolean; dateOfBirth?: string | null }): Promise<Player>;
  exportMyData(): Promise<Record<string, unknown>>;
  requestAccountDeletion(): Promise<{ deleteOn: ISODate }>;

  // Ovalcast staff console. Staff only.
  staffListOrganisations(): Promise<StaffOrgSummary[]>;
  staffSetPlan(orgId: ID, plan: 'free' | 'organisation'): Promise<Organisation>;
  staffListCertificates(): Promise<PendingCertificate[]>;
  staffReviewCertificate(certificateId: ID, decision: 'verified' | 'rejected'): Promise<PendingCertificate>;
  staffIssueApiKey(orgId: ID, name: string, live: boolean): Promise<IssuedApiKey>;
  staffRefundPasses(matchId: ID, reason: string): Promise<{ refunded: number; amount: number }>;
  // GET /staff/shares, PUT /staff/shares: Ovalcast's platform share of paid streams and share of entry fees (0.25 = 25%).
  staffShares(): Promise<StaffShares>;
  staffSetShares(input: { platformShare?: number; entryShare?: number }): Promise<Omit<StaffShares, 'organisations' | 'streamers'>>;
  // PUT /staff/organisations/:id/shares, PUT /staff/users/:id/platform-share: their own rates; null goes back to the default.
  staffSetOrganisationShares(orgId: ID, input: { platformShare?: number | null; entryShare?: number | null }): Promise<{ platformShare: number | null; entryShare: number | null }>;
  staffSetStreamerShare(userId: ID, platformShare: number | null): Promise<{ platformShare: number | null }>;
  /** Switches website embeds on or off for an organisation. */
  staffSetEmbeds(orgId: ID, approved: boolean): Promise<EmbedSettings>;

  // Website embeds. GET|PUT /organisations/:id/embeds (league admins), POST /organisations/:id/embeds/request,
  // GET /embeds/access?orgId=|competitionId= (public)
  getEmbedSettings(orgId: ID): Promise<EmbedSettings>;
  requestEmbeds(orgId: ID): Promise<EmbedSettings>;
  setEmbedDomains(orgId: ID, domains: string[]): Promise<EmbedSettings>;
  getEmbedAccess(params: { orgId?: ID; competitionId?: ID }): Promise<EmbedAccess>;
  // Backoffice. GET /staff/overview?days= , GET /staff/users?q=&filter=&before= , GET /staff/users/:id ,
  // POST /staff/users/:id/suspend|unsuspend|sign-out|unlock , GET /staff/activity?kind=&userId=&before= , GET /staff/money?days=
  staffOverview(days: number): Promise<StaffOverview>;
  staffListUsers(params?: { q?: string; filter?: StaffUserFilter; before?: ISODate }): Promise<StaffUserRow[]>;
  staffGetUser(id: ID): Promise<StaffUserDetail>;
  staffSuspendUser(id: ID, reason: string): Promise<StaffUserDetail>;
  staffUnsuspendUser(id: ID): Promise<StaffUserDetail>;
  staffSignOutUser(id: ID): Promise<StaffUserDetail>;
  staffUnlockUser(id: ID): Promise<StaffUserDetail>;
  staffActivity(params?: { kind?: ActivityKind; userId?: ID; before?: ISODate }): Promise<ActivityItem[]>;
  staffStreamingMoney(days: number): Promise<StreamingMoney>;

  // GET /streams?status=live , GET /streams/:id , GET /matches/:id/clips
  listStreams(params?: { status?: Stream['status'] }): Promise<Stream[]>;
  getStream(id: ID): Promise<Stream>;
  listClips(matchId: ID): Promise<Clip[]>;
}
