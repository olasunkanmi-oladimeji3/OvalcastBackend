// Scoring engine types. The engine is pure TypeScript with no React or network
// code, so the same package can run on the phone and on the server.

export type ExtraKind = 'wide' | 'noBall' | 'bye' | 'legBye' | 'penalty';

export type DismissalKind =
  | 'bowled'
  | 'caught'
  | 'lbw'
  | 'stumped'
  | 'runOut'
  | 'hitWicket'
  | 'obstructing'
  | 'hitTwice'
  | 'timedOut'
  | 'retiredOut'
  | 'retiredHurt';

/** Competition rules layered on top of the Laws (PRD: "playing conditions"). */
export interface PlayingConditions {
  ballsPerOver: number;
  oversPerInnings: number;
  wideRuns: number;
  noBallRuns: number;
  freeHit: boolean;
  maxOversPerBowler: number;
  powerplayOvers: number;
  superOver: boolean;
}

export interface ShotData {
  /** Degrees from directly behind the batter, round through the leg side, for a right-hander: 0 fine leg, 180 straight, 270 point. */
  angle: number;
  /** 1 = infield, 2 = outfield, 3 = boundary. */
  distance: 1 | 2 | 3;
}

/**
 * One delivery (or a void that cancels one). Append-only: an edit is a void of
 * the old event plus a new event with the same `seq`.
 */
export interface BallEvent {
  id: string;
  /** Generated on the phone; the server de-duplicates offline syncs with it. */
  clientId: string;
  matchId: string;
  innings: number;
  seq: number;
  kind: 'delivery' | 'void';
  voidOf?: string;
  strikerId: string;
  nonStrikerId: string;
  bowlerId: string;
  /** Runs off the bat, including a boundary. */
  bat: number;
  boundary?: boolean;
  /** `runs` are runs run (or a boundary) on top of the wide/no-ball penalty. */
  extra?: { kind: ExtraKind; runs: number; nbVia?: 'bat' | 'bye' | 'legBye' };
  wicket?: { kind: DismissalKind; playerOutId: string; fielderId?: string };
  newBatterId?: string;
  shot?: ShotData;
  createdAt: string;
  createdBy: string;
}

export interface PlayerRef {
  id: string;
  name: string;
  shortName: string;
}

export interface TeamSetup {
  id: string;
  name: string;
  shortName: string;
  players: PlayerRef[];
  /**
   * The 12th man and other substitute fielders (Law 24): squad players outside the XI. They may field,
   * and keep wicket with the umpires' consent, but not bat, bowl or captain. Scorecards show them as
   * "sub (Name)".
   */
  substitutes?: PlayerRef[];
}

export interface MatchSetup {
  conditions: PlayingConditions;
  teams: [TeamSetup, TeamSetup];
  battingFirstTeamId: string;
  /** Overs cut by rain, bad light or a late start, and the chase's revised target. */
  reduced?: { overs: [number, number]; target?: number; rule: import('./rain').RainRule };
}

export interface BatterLine {
  playerId: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  order: number;
  out?: { kind: DismissalKind; text: string };
}

export interface BowlerLine {
  playerId: string;
  balls: number;
  runs: number;
  wickets: number;
  maidens: number;
  wides: number;
  noBalls: number;
  dots: number;
}

/** Short label for a ball in "this over": 1, 4, W, wd, nb+4, lb2, and so on. */
export interface BallChip {
  eventId: string;
  label: string;
  tone: 'dot' | 'run' | 'four' | 'six' | 'wicket' | 'extra';
}

export interface OverSummary {
  number: number; // 1-based
  bowlerId: string;
  runs: number;
  wickets: number;
  /** Runs charged to the bowler this over; zero over a full over is a maiden. */
  bowlerConceded: number;
  chips: BallChip[];
}

export interface FallOfWicket {
  wicket: number;
  runs: number;
  playerId: string;
  over: string;
}

export interface Partnership {
  wicket: number;
  runs: number;
  balls: number;
  batterIds: [string, string];
}

export interface InningsState {
  number: number;
  battingTeamId: string;
  bowlingTeamId: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: { wide: number; noBall: number; bye: number; legBye: number; penalty: number };
  batters: BatterLine[];
  bowlers: BowlerLine[];
  strikerId?: string;
  nonStrikerId?: string;
  bowlerId?: string;
  lastOverBowlerId?: string;
  fallOfWickets: FallOfWicket[];
  partnerships: Partnership[];
  overs: OverSummary[];
  freeHitNext: boolean;
  complete: boolean;
  target?: number;
  /** Overs this innings can last: the match's overs, or fewer after rain. */
  maxOvers: number;
  shots: { batterId: string; runs: number; shot: ShotData }[];
}

export interface MatchResult {
  kind: 'runs' | 'wickets' | 'tie' | 'noResult';
  winnerTeamId?: string;
  margin?: number;
  text: string;
}

export interface MatchState {
  innings: InningsState[];
  current?: InningsState;
  result?: MatchResult;
}
