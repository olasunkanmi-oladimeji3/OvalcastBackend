// Demo data: one organisation with two divisions, fictional Lagos clubs and
// players, results so far, a live match and a fixture the demo user scores.
// Club and player names are invented for the demo.

import { FREE_FOR_ALL, type FeatureAccess } from '@/engine';
import type { BallEvent, MatchSetup, PlayingConditions } from "@/engine";
import { dueSettlements, replay, roundRobin } from "@/engine";
import type {
  OfficialRole,
  FixtureRequest,
  TeamSheet,
  ApiClientSummary,
  PlayerClaim,
  RulesDocumentVersion,
  HostEarnings,
  MatchPass,
  Subscription,
  ViewerCredits,
  Wallet,
  OfficialInvite,
  OfficiatingProfile,
  PayoutAccount,
  Settlement,
  PointDeduction,
  AppNotification,
  Clip,
  Story,
  StoryComment,
  StoryKind,
  CommunityPost,
  Competition,
  CompetitionEntry,
  Match,
  Organisation,
  Payment,
  Player,
  PlayerInvite,
  PlayerRole,
  PlayerRules,
  Region,
  Registration,
  StaffMember,
  Stream,
  Team,
  Transfer,
  User,
} from "../types";
import { mulberry32, simulate, type Rng } from "./simulate";

const rng = mulberry32(2026);

export const T20: PlayingConditions = {
  ballsPerOver: 6,
  oversPerInnings: 20,
  wideRuns: 1,
  noBallRuns: 1,
  freeHit: true,
  maxOversPerBowler: 4,
  powerplayOvers: 6,
  superOver: true,
};

const premierClubs: [string, string, string, string, string][] = [
  ["surulere", "Surulere Strikers", "SUR", "#7A1F2B", "Surulere Ground"],
  ["ikeja", "Ikeja Titans", "IKJ", "#1B3A6B", "Ikeja Cantonment Oval"],
  ["yaba", "Yaba Royals", "YAB", "#5B2C83", "Onikan Oval"],
  ["lekki", "Lekki Waves", "LEK", "#0F6E7A", "Lekki Sports Field"],
  ["apapa", "Apapa Dockers", "APA", "#B4561B", "Apapa Marine Ground"],
  ["vi", "Island Mariners", "ISL", "#22313F", "Onikan Oval"],
];

const divOneClubs: [string, string, string, string, string][] = [
  ["festac", "Festac Falcons", "FES", "#2E5E2A", "Festac Town Field"],
  ["ajah", "Ajah Rangers", "AJA", "#8A6D1D", "Ajah Community Oval"],
  ["ikorodu", "Ikorodu Bulls", "IKR", "#7B2D26", "Ikorodu Stadium"],
  ["ojota", "Ojota Comets", "OJO", "#3B4C7A", "Ojota Recreation Ground"],
  ["agege", "Agege Eagles", "AGG", "#5E3A1E", "Agege Stadium Annex"],
  ["badagry", "Badagry Pirates", "BAD", "#1E4E5C", "Badagry Beach Oval"],
  ["gbagada", "Gbagada Giants", "GBG", "#4A2F6B", "Gbagada Phase 2 Field"],
  ["maryland", "Maryland Pacers", "MRY", "#6B3A3A", "Maryland Sports Club"],
];

const firstNames = [
  "Tunde",
  "Chidi",
  "Emeka",
  "Seyi",
  "Kunle",
  "Ifeanyi",
  "Bayo",
  "Obinna",
  "Femi",
  "Uche",
  "Dayo",
  "Segun",
  "Nnamdi",
  "Gbenga",
  "Kelechi",
  "Wale",
  "Tobi",
  "Ade",
  "Chukwudi",
  "Rotimi",
  "Sola",
  "Ikenna",
  "Yinka",
  "Musa",
  "Ibrahim",
  "Sadiq",
  "Daniel",
  "Samuel",
  "Joshua",
  "David",
  "Victor",
  "Peter",
  "Akin",
  "Lanre",
  "Ope",
  "Jide",
];
const lastNames = [
  "Adeyemi",
  "Okafor",
  "Balogun",
  "Nwosu",
  "Ogunleye",
  "Eze",
  "Bello",
  "Ojo",
  "Okonkwo",
  "Afolabi",
  "Lawal",
  "Onyeka",
  "Adebayo",
  "Uzor",
  "Salami",
  "Ibe",
  "Coker",
  "Akande",
  "Nwachukwu",
  "Oyelaran",
  "Ajayi",
  "Okeke",
  "Danjuma",
  "Abubakar",
  "Olatunji",
  "Ekwueme",
  "Fashola",
  "Obi",
  "Ilesanmi",
  "Ogbonna",
  "Bankole",
  "Agu",
];

const roles: PlayerRole[] = [
  "batter",
  "batter",
  "keeper",
  "batter",
  "allRounder",
  "allRounder",
  "batter",
  "bowler",
  "bowler",
  "bowler",
  "bowler",
  "allRounder",
  "bowler",
];
const bowlingStyles = [
  "Right-arm fast-medium",
  "Right-arm medium",
  "Left-arm orthodox",
  "Right-arm off break",
  "Right-arm leg break",
  "Left-arm medium",
];

const ORG_ID = "org_ccc";

/** Umpires on the demo fixtures who have Ovalcast accounts. */
const UMPIRE_USERS: Record<string, string> = {
  "K. Adewale": "user_adewale",
  "J. Etim": "user_etim",
  "M. Garba": "user_garba",
};

export const REGIONS: Region[] = [
  {
    id: "lagos",
    name: "Lagos",
    country: "Nigeria",
    lat: 6.5244,
    lon: 3.3792,
    cities: ["Lagos"],
  },
  {
    id: "abuja",
    name: "Abuja",
    country: "Nigeria",
    lat: 9.0765,
    lon: 7.3986,
    cities: ["Abuja"],
  },
  {
    id: "ibadan",
    name: "Ibadan",
    country: "Nigeria",
    lat: 7.3775,
    lon: 3.947,
    cities: ["Ibadan"],
  },
  {
    id: "port-harcourt",
    name: "Port Harcourt",
    country: "Nigeria",
    lat: 4.8156,
    lon: 7.0498,
    cities: ["Port Harcourt"],
  },
  {
    id: "kano",
    name: "Kano",
    country: "Nigeria",
    lat: 12.0022,
    lon: 8.592,
    cities: ["Kano"],
  },
  {
    id: "accra",
    name: "Accra",
    country: "Ghana",
    lat: 5.6037,
    lon: -0.187,
    cities: ["Accra"],
  },
  {
    id: "freetown",
    name: "Freetown",
    country: "Sierra Leone",
    lat: 8.4657,
    lon: -13.2317,
    cities: ["Freetown"],
  },
  {
    id: "banjul",
    name: "Banjul",
    country: "Gambia",
    lat: 13.4549,
    lon: -16.579,
    cities: ["Banjul", "Serrekunda"],
  },
  {
    id: "nairobi",
    name: "Nairobi",
    country: "Kenya",
    lat: -1.2921,
    lon: 36.8219,
    cities: ["Nairobi"],
  },
  {
    id: "mombasa",
    name: "Mombasa",
    country: "Kenya",
    lat: -4.0435,
    lon: 39.6682,
    cities: ["Mombasa"],
  },
  {
    id: "kampala",
    name: "Kampala",
    country: "Uganda",
    lat: 0.3476,
    lon: 32.5825,
    cities: ["Kampala", "Entebbe"],
  },
  {
    id: "dar-es-salaam",
    name: "Dar es Salaam",
    country: "Tanzania",
    lat: -6.7924,
    lon: 39.2083,
    cities: ["Dar es Salaam"],
  },
  {
    id: "kigali",
    name: "Kigali",
    country: "Rwanda",
    lat: -1.9441,
    lon: 30.0619,
    cities: ["Kigali"],
  },
  {
    id: "johannesburg",
    name: "Johannesburg",
    country: "South Africa",
    lat: -26.2041,
    lon: 28.0473,
    cities: ["Johannesburg", "Pretoria"],
  },
  {
    id: "cape-town",
    name: "Cape Town",
    country: "South Africa",
    lat: -33.9249,
    lon: 18.4241,
    cities: ["Cape Town"],
  },
  {
    id: "durban",
    name: "Durban",
    country: "South Africa",
    lat: -29.8587,
    lon: 31.0218,
    cities: ["Durban"],
  },
  {
    id: "lusaka",
    name: "Lusaka",
    country: "Zambia",
    lat: -15.3875,
    lon: 28.3228,
    cities: ["Lusaka"],
  },
  {
    id: "blantyre",
    name: "Blantyre",
    country: "Malawi",
    lat: -15.7861,
    lon: 35.0058,
    cities: ["Blantyre", "Lilongwe"],
  },
  {
    id: "harare",
    name: "Harare",
    country: "Zimbabwe",
    lat: -17.8252,
    lon: 31.0335,
    cities: ["Harare", "Bulawayo"],
  },
  {
    id: "windhoek",
    name: "Windhoek",
    country: "Namibia",
    lat: -22.5609,
    lon: 17.0658,
    cities: ["Windhoek"],
  },
  {
    id: "gaborone",
    name: "Gaborone",
    country: "Botswana",
    lat: -24.6282,
    lon: 25.9231,
    cities: ["Gaborone"],
  },
  {
    id: "douala",
    name: "Douala",
    country: "Cameroon",
    lat: 4.0511,
    lon: 9.7679,
    cities: ["Douala", "Yaoundé"],
  },
  {
    id: "abidjan",
    name: "Abidjan",
    country: "Côte d'Ivoire",
    lat: 5.36,
    lon: -4.0083,
    cities: ["Abidjan"],
  },
  {
    id: "dakar",
    name: "Dakar",
    country: "Senegal",
    lat: 14.7167,
    lon: -17.4677,
    cities: ["Dakar"],
  },
  {
    id: "london",
    name: "London",
    country: "United Kingdom",
    lat: 51.5072,
    lon: -0.1276,
    cities: ["London", "Reading"],
  },
  {
    id: "birmingham",
    name: "Birmingham",
    country: "United Kingdom",
    lat: 52.4862,
    lon: -1.8904,
    cities: ["Birmingham"],
  },
  {
    id: "manchester",
    name: "Manchester",
    country: "United Kingdom",
    lat: 53.4808,
    lon: -2.2426,
    cities: ["Manchester", "Leeds", "Bradford"],
  },
  {
    id: "dublin",
    name: "Dublin",
    country: "Ireland",
    lat: 53.3498,
    lon: -6.2603,
    cities: ["Dublin"],
  },
  {
    id: "amsterdam",
    name: "Amsterdam",
    country: "Netherlands",
    lat: 52.3676,
    lon: 4.9041,
    cities: ["Amsterdam", "The Hague", "Rotterdam"],
  },
  {
    id: "new-york",
    name: "New York",
    country: "United States",
    lat: 40.7128,
    lon: -74.006,
    cities: ["New York", "New Jersey"],
  },
  {
    id: "dallas",
    name: "Dallas",
    country: "United States",
    lat: 32.7767,
    lon: -96.797,
    cities: ["Dallas", "Houston"],
  },
  {
    id: "toronto",
    name: "Toronto",
    country: "Canada",
    lat: 43.6532,
    lon: -79.3832,
    cities: ["Toronto", "Brampton"],
  },
  {
    id: "mumbai",
    name: "Mumbai",
    country: "India",
    lat: 19.076,
    lon: 72.8777,
    cities: ["Mumbai", "Pune"],
  },
  {
    id: "delhi",
    name: "Delhi",
    country: "India",
    lat: 28.6139,
    lon: 77.209,
    cities: ["Delhi"],
  },
  {
    id: "karachi",
    name: "Karachi",
    country: "Pakistan",
    lat: 24.8607,
    lon: 67.0011,
    cities: ["Karachi"],
  },
  {
    id: "lahore",
    name: "Lahore",
    country: "Pakistan",
    lat: 31.5204,
    lon: 74.3587,
    cities: ["Lahore"],
  },
  {
    id: "dhaka",
    name: "Dhaka",
    country: "Bangladesh",
    lat: 23.8103,
    lon: 90.4125,
    cities: ["Dhaka"],
  },
  {
    id: "colombo",
    name: "Colombo",
    country: "Sri Lanka",
    lat: 6.9271,
    lon: 79.8612,
    cities: ["Colombo"],
  },
  {
    id: "kathmandu",
    name: "Kathmandu",
    country: "Nepal",
    lat: 27.7172,
    lon: 85.324,
    cities: ["Kathmandu"],
  },
  {
    id: "dubai",
    name: "Dubai",
    country: "United Arab Emirates",
    lat: 25.2048,
    lon: 55.2708,
    cities: ["Dubai", "Sharjah", "Abu Dhabi"],
  },
  {
    id: "sydney",
    name: "Sydney",
    country: "Australia",
    lat: -33.8688,
    lon: 151.2093,
    cities: ["Sydney"],
  },
  {
    id: "melbourne",
    name: "Melbourne",
    country: "Australia",
    lat: -37.8136,
    lon: 144.9631,
    cities: ["Melbourne"],
  },
  {
    id: "auckland",
    name: "Auckland",
    country: "New Zealand",
    lat: -36.8485,
    lon: 174.7633,
    cities: ["Auckland"],
  },
];

/** Clubs outside Lagos, so the regional leaders change with location. */
const otherRegionClubs: [string, string, string, string, string, string][] = [
  ["wuse", "Wuse Warriors", "WUS", "#1B5E20", "Old Parade Ground", "Abuja"],
  [
    "garki",
    "Garki Gladiators",
    "GAR",
    "#8E2430",
    "Garki Area 11 Field",
    "Abuja",
  ],
  [
    "maitama",
    "Maitama Mavericks",
    "MAI",
    "#283F7A",
    "Maitama Sports Field",
    "Abuja",
  ],
  [
    "bodija",
    "Bodija Blazers",
    "BOD",
    "#A0522D",
    "University of Ibadan Oval",
    "Ibadan",
  ],
  [
    "ring-road",
    "Ring Road Rovers",
    "RRR",
    "#3D5A3D",
    "Liberty Stadium Annex",
    "Ibadan",
  ],
  ["osu", "Osu Oaks", "OSU", "#B71C1C", "Achimota Oval", "Accra"],
  ["labadi", "Labadi Lions", "LAB", "#F2A900", "Labadi Sports Ground", "Accra"],
  ["tema", "Tema Tusks", "TEM", "#00695C", "Tema Community 1 Park", "Accra"],
  ["kingtom", "Kingtom Kestrels", "KIN", "#1565C0", "Kingtom Oval", "Freetown"],
  [
    "serrekunda",
    "Serrekunda Stars",
    "SER",
    "#AD1457",
    "Independence Stadium Annex",
    "Serrekunda",
  ],
];

const ORG_FOR_CITY: Record<string, string> = {
  Abuja: "org_abuja",
  Ibadan: "org_ibadan",
  Accra: "org_accra",
  Freetown: "org_freetown",
  Serrekunda: "org_banjul",
};

export const rulesOf = (o: Partial<PlayerRules> = {}): PlayerRules => ({
  multiClub: { allowed: false, maxClubs: 1 },
  otherLeagues: "allowed",
  guestPlayersPerXI: 0,
  minMatchesForKnockouts: 0,
  transfers: null,
  ...o,
});

function makeTeam(
  [slug, name, short, color, ground]: [string, string, string, string, string],
  founded: number,
): Team {
  return {
    id: `team_${slug}`,
    orgId: ORG_ID,
    city: "Lagos",
    name,
    shortName: short,
    colors: [color, "#F7F8F1"],
    homeGround: ground,
    founded,
    staff: [],
  };
}

function makeSquad(team: Team, r: Rng, used: Set<string>): Player[] {
  return roles.map((role, i) => {
    let full = "";
    do {
      full = `${firstNames[Math.floor(r() * firstNames.length)]} ${lastNames[Math.floor(r() * lastNames.length)]}`;
    } while (used.has(full));
    used.add(full);
    const [f, l] = full.split(" ");
    return {
      id: `${team.id}_p${i + 1}`,
      teamId: team.id,
      name: full,
      shortName: `${f[0]}. ${l}`,
      role,
      battingHand: r() < 0.25 ? "L" : "R",
      bowlingStyle:
        role === "bowler" || role === "allRounder"
          ? bowlingStyles[Math.floor(r() * bowlingStyles.length)]
          : undefined,
    };
  });
}

export interface Db {
  me: User;
  /** Every account, including `me`. */
  users: User[];
  officiating: Record<string, OfficiatingProfile>;
  officialInvites: OfficialInvite[];
  deductions: PointDeduction[];
  notifications: AppNotification[];
  posts: CommunityPost[];
  registrations: Registration[];
  transfers: Transfer[];
  org: Organisation;
  /** Other organisations, whose leagues the demo user's club can join. */
  otherOrgs: Organisation[];
  entries: CompetitionEntry[];
  playerInvites: PlayerInvite[];
  teams: Team[];
  players: Player[];
  competitions: Competition[];
  matches: Match[];
  balls: Record<string, BallEvent[]>;
  streams: Stream[];
  clips: Clip[];
  /** The feed. `likedBy` stands in for the likes table. */
  stories: (Omit<Story, 'liked' | 'canDelete'> & { likedBy: string[] })[];
  storyComments: StoryComment[];
  /** Per organisation. */
  payoutAccounts: Record<string, PayoutAccount>;
  settlements: Settlement[];
  // Business model.
  subscriptions: (Subscription & { userId: string })[];
  wallets: Record<string, Wallet>;
  /** Paid streams, by match. */
  passOffers: Record<
    string,
    { price: number; hostUserId: string; hostName: string }
  >;
  passes: MatchPass[];
  /** Pass income per hosted match, for host earnings. */
  passSales: {
    matchId: string;
    hostUserId: string;
    passes: number;
    gross: number;
    fees: number;
    host: number;
    at: string;
  }[];
  hostPayouts: Record<string, HostEarnings["payouts"]>;
  viewerCredits: Record<string, ViewerCredits>;
  rulesVersions: Record<string, RulesDocumentVersion[]>;
  claims: PlayerClaim[];
  /** Organisations and clubs with a YouTube stream key saved. */
  youtube: Record<string, boolean>;
  apiClients: Record<string, ApiClientSummary[]>;
  teamSheets: TeamSheet[];
  fixtureRequests: FixtureRequest[];
  /** Ratings of officials by people who worked a match with them. */
  ratings: { id: string; userId: string; raterId: string; raterName: string; role: import('@/engine').RatedRole; matchId?: string; scores: Record<string, number>; comment?: string; at: string }[];
  /** Which features need a paid plan: everything free at launch. */
  featureAccess: FeatureAccess;
}

const day = 86_400_000;

export function setupFor(
  db: Pick<Db, "players" | "teams" | "competitions">,
  m: Match,
): MatchSetup {
  const comp = db.competitions.find((c) => c.id === m.competitionId);
  const team = (id: string) => {
    const t = db.teams.find((x) => x.id === id)!;
    const xi = m.playingXI?.[id];
    // Practice sides pick from their club's squad.
    const squad = db.players.filter(
      (p) =>
        p.teamId === id || (!!t.parentTeamId && p.teamId === t.parentTeamId),
    );
    const players = (
      xi
        ? xi.map((pid) => squad.find((p) => p.id === pid)!)
        : squad.slice(0, 11)
    ).map((p) => ({ id: p.id, name: p.name, shortName: p.shortName }));
    // The rest of the squad can come on as substitute fielders: the 12th man (Law 24).
    const substitutes = squad.filter((p) => !p.guest && !players.some((x) => x.id === p.id)).map((p) => ({ id: p.id, name: p.name, shortName: p.shortName }));
    return { id: t.id, name: t.name, shortName: t.shortName, players, substitutes };
  };
  return {
    conditions: m.conditions ?? comp?.conditions ?? T20,
    teams: [team(m.homeTeamId), team(m.awayTeamId)],
    battingFirstTeamId: m.battingFirstTeamId ?? m.homeTeamId,
    reduced: m.reduced ? { overs: m.reduced.overs, target: m.reduced.target, rule: m.reduced.rule } : undefined,
  };
}

/** Recomputes a match's scores, status and result from its ball events. */
export function refreshFromEvents(db: Db, m: Match) {
  const events = db.balls[m.id] ?? [];
  if (!m.battingFirstTeamId) return;
  const setup = setupFor(db, m);
  const state = replay(setup, events);
  m.scores = state.innings
    .filter((i) => i.legalBalls > 0 || i.runs > 0 || i.number === 1)
    .map((i) => ({
      teamId: i.battingTeamId,
      runs: i.runs,
      wickets: i.wickets,
      balls: i.legalBalls,
      allOut: i.wickets >= 10,
    }));
  if (state.result) {
    m.status = "completed";
    m.result = {
      text: state.result.text,
      winnerTeamId: state.result.winnerTeamId,
      outcome: state.result.kind === "tie" ? "tie" : "win",
    };
  } else if (events.length > 0) {
    m.status =
      state.innings.length === 2 &&
      state.innings[1].legalBalls === 0 &&
      state.innings[0].complete
        ? "inningsBreak"
        : "live";
  }
}

export function createSeed(now = new Date()): Db {
  const used = new Set<string>();
  const premier = premierClubs.map((c, i) => makeTeam(c, 1958 + i * 7));
  const divOne = divOneClubs.map((c, i) => makeTeam(c, 1975 + i * 5));
  const elsewhere = otherRegionClubs.map(
    ([slug, name, short, color, ground, city], i) => ({
      ...makeTeam([slug, name, short, color, ground], 1990 + i * 4),
      orgId: ORG_FOR_CITY[city],
      city,
    }),
  );
  const teams = [...premier, ...divOne, ...elsewhere];
  const players = teams.flatMap((t) => makeSquad(t, rng, used));
  // The demo user also plays, opening the batting for Yaba Royals, so their playing career has matches in it.
  players.splice(players.findIndex((p) => p.teamId === "team_yaba"), 0, {
    id: "player_me",
    teamId: "team_yaba",
    name: "Tunde Bakare",
    shortName: "T. Bakare",
    role: "allRounder",
    battingHand: "R",
    bowlingStyle: "Right-arm off break",
  });

  const premierComp: Competition = {
    id: "comp_prem_2627",
    orgId: ORG_ID,
    name: "Premier League",
    season: "2026/27",
    division: "Premier League",
    format: "T20",
    ballType: "leather",
    conditions: T20,
    points: { win: 2, tie: 1, noResult: 1, loss: 0 },
    tieBreakers: ["wins", "nrr", "headToHead"],
    stages: [
      {
        id: "stage_prem_league",
        name: "League stage",
        kind: "roundRobin",
        groups: [
          {
            id: "grp_prem",
            name: "Premier League",
            teamIds: premier.map((t) => t.id),
          },
        ],
        qualify: {
          topPerGroup: 4,
          toStageId: "stage_prem_super4",
          carryForward: "fresh",
        },
      },
      {
        id: "stage_prem_super4",
        name: "Super 4",
        kind: "superStage",
        groups: [{ id: "grp_super4", name: "Super 4", teamIds: [] }],
      },
    ],
    teamIds: premier.map((t) => t.id),
    status: "inProgress",
    entryPolicy: "inviteOnly",
    entryFee: 150000,
    maxTeams: 6,
    startsOn: new Date(now.getTime() - 21 * day).toISOString(),
    playerRules: rulesOf({
      transfers: {
        windows: [
          {
            name: "Mid-season window",
            opensOn: new Date(now.getTime() - 3 * day).toISOString(),
            closesOn: new Date(now.getTime() + 11 * day).toISOString(),
          },
        ],
        maxPerPlayer: 1,
      },
    }),
    rulesDocument: {
      name: "Premier League playing conditions 2026-27.pdf",
      version: 2,
      uploadedAt: new Date(now.getTime() - 40 * day).toISOString(),
      sizeKb: 412,
    },
    seasonRules: [
      "Top 4 of the league stage play a Super 4",
      "Bottom team of the league stage is relegated to Division One",
    ],
  };

  const divOneComp: Competition = {
    id: "comp_div1_2627",
    orgId: ORG_ID,
    name: "Division One",
    season: "2026/27",
    division: "Division One",
    format: "T20",
    ballType: "leather",
    conditions: { ...T20, freeHit: false },
    points: { win: 2, tie: 1, noResult: 1, loss: 0 },
    tieBreakers: ["wins", "nrr", "headToHead"],
    stages: [
      {
        id: "stage_div1_groups",
        name: "Group stage",
        kind: "roundRobin",
        groups: [
          {
            id: "grp_a",
            name: "Group A",
            teamIds: divOne.slice(0, 4).map((t) => t.id),
          },
          {
            id: "grp_b",
            name: "Group B",
            teamIds: divOne.slice(4).map((t) => t.id),
          },
        ],
        qualify: {
          topPerGroup: 3,
          toStageId: "stage_div1_super6",
          carryForward: "all",
        },
      },
      {
        id: "stage_div1_super6",
        name: "Super Six",
        kind: "superStage",
        groups: [{ id: "grp_super6", name: "Super Six", teamIds: [] }],
      },
    ],
    teamIds: divOne.map((t) => t.id),
    status: "inProgress",
    entryPolicy: "inviteOnly",
    entryFee: 100000,
    maxTeams: 8,
    startsOn: new Date(now.getTime() - 20 * day).toISOString(),
    playerRules: rulesOf({
      otherLeagues: "notSameOrganisation",
      minMatchesForKnockouts: 3,
      transfers: {
        windows: [
          {
            name: "Before the Super Six",
            opensOn: new Date(now.getTime() + 28 * day).toISOString(),
            closesOn: new Date(now.getTime() + 35 * day).toISOString(),
          },
        ],
        maxPerPlayer: 1,
      },
    }),
    rulesDocument: {
      name: "Division One rules 2026-27.docx",
      version: 1,
      uploadedAt: new Date(now.getTime() - 35 * day).toISOString(),
      sizeKb: 188,
    },
    seasonRules: [
      "Top 3 from each group play a Super Six, carrying their group record",
      "Super Six winner is promoted to the Premier League",
    ],
  };

  // Leagues taking entries, to show invites and join requests.
  const entryComp = (
    id: string,
    orgId: string,
    name: string,
    format: Competition["format"],
    overs: number,
    policy: Competition["entryPolicy"],
    fee: number,
    maxTeams: number,
    startsInDays: number,
    rules: string[],
    playerRules: PlayerRules,
  ): Competition => ({
    playerRules,
    id,
    orgId,
    name,
    season: "2026",
    division: name,
    format,
    ballType: format === "T10" ? "tennis" : "leather",
    conditions: {
      ...T20,
      oversPerInnings: overs,
      maxOversPerBowler: Math.ceil(overs / 5),
      powerplayOvers: Math.round(overs * 0.3),
    },
    points: { win: 2, tie: 1, noResult: 1, loss: 0 },
    tieBreakers: ["wins", "nrr", "headToHead"],
    stages: [
      {
        id: `${id}_league`,
        name: "League",
        kind: "roundRobin",
        groups: [{ id: `${id}_all`, name: "All teams", teamIds: [] }],
      },
    ],
    teamIds: [],
    status: "entries",
    entryPolicy: policy,
    entryFee: fee,
    maxTeams,
    startsOn: new Date(now.getTime() + startsInDays * day).toISOString(),
    seasonRules: rules,
  });
  const t10Cup = entryComp(
    "comp_t10_cup",
    ORG_ID,
    "CCC T10 Cup",
    "T10",
    10,
    "open",
    50000,
    8,
    24,
    ["A single league, top 2 meet in the final"],
    rulesOf({
      multiClub: { allowed: true, maxClubs: 2 },
      guestPlayersPerXI: 2,
      transfers: {
        windows: [
          {
            name: "Squad changes",
            opensOn: new Date(now.getTime() - 5 * day).toISOString(),
            closesOn: new Date(now.getTime() + 20 * day).toISOString(),
          },
        ],
        maxPerPlayer: 2,
      },
    }),
  );
  const ekoLeague = entryComp(
    "comp_eko_social",
    "org_eko",
    "Eko Social League",
    "T20",
    20,
    "inviteOnly",
    75000,
    6,
    30,
    ["Sunday afternoon fixtures at Onikan Oval"],
    rulesOf({ guestPlayersPerXI: 1 }),
  );
  const mainland = entryComp(
    "comp_mainland_open",
    "org_eko",
    "Mainland Open",
    "T10",
    10,
    "open",
    25000,
    10,
    40,
    ["Tennis-ball, one day, open to any club"],
    rulesOf({ otherLeagues: "allowed", guestPlayersPerXI: 3 }),
  );
  t10Cup.teamIds = ["team_surulere", "team_lekki"];
  t10Cup.stages[0].groups[0].teamIds = [...t10Cup.teamIds];
  ekoLeague.teamIds = ["team_vi"];
  ekoLeague.stages[0].groups[0].teamIds = [...ekoLeague.teamIds];

  const accraBash = entryComp(
    "comp_accra_bash",
    "org_accra",
    "Accra T20 Bash",
    "T20",
    20,
    "open",
    600,
    8,
    21,
    ["League, then a final at Achimota Oval"],
    rulesOf({
      guestPlayersPerXI: 1,
      transfers: {
        windows: [
          {
            name: "Squad changes",
            opensOn: new Date(now.getTime() - 2 * day).toISOString(),
            closesOn: new Date(now.getTime() + 14 * day).toISOString(),
          },
        ],
        maxPerPlayer: 1,
      },
    }),
  );
  accraBash.teamIds = ["team_osu", "team_labadi"];
  accraBash.stages[0].groups[0].teamIds = [...accraBash.teamIds];

  // Clients outside West Africa: Kenya (shillings, M-Pesa) and England (pounds, a summer season).
  const nairobiCup = entryComp(
    "comp_nairobi_cup",
    "org_nairobi",
    "Nairobi Twenty20 Cup",
    "T20",
    20,
    "open",
    2500,
    8,
    28,
    ["Groups at Sikh Union and Nairobi Gymkhana, then finals"],
    rulesOf({ guestPlayersPerXI: 1 }),
  );
  const thamesLeague = entryComp(
    "comp_thames_sunday",
    "org_thames",
    "Thames Valley Sunday League",
    "Custom",
    40,
    "open",
    60,
    10,
    35,
    ["One division, home and away", "Top club wins the Sunday Shield"],
    rulesOf({}),
  );
  thamesLeague.season = "2027";
  const competitions = [
    premierComp,
    divOneComp,
    t10Cup,
    ekoLeague,
    mainland,
    accraBash,
    nairobiCup,
    thamesLeague,
  ];
  const matches: Match[] = [];
  const balls: Record<string, BallEvent[]> = {};
  const umpirePool = [
    "K. Adewale",
    "J. Etim",
    "O. Babatunde",
    "S. Nwafor",
    "M. Garba",
    "R. Oyebanji",
  ];

  const addFixtures = (
    comp: Competition,
    stageId: string,
    groupId: string,
    teamIds: string[],
    startDaysAgo: number,
    playedRounds: number,
  ) => {
    roundRobin(teamIds).forEach((round, ri) => {
      round.forEach(([home, away], mi) => {
        const id = `m_${comp.id.slice(5, 9)}_${groupId}_${ri + 1}_${mi + 1}`;
        const startsAt = new Date(
          now.getTime() - (startDaysAgo - ri * 7) * day,
        );
        startsAt.setHours(10 + (mi % 2) * 4, 0, 0, 0);
        const ht = teams.find((t) => t.id === home)!;
        const m: Match = {
          id,
          competitionId: comp.id,
          stageId,
          groupId,
          homeTeamId: home,
          awayTeamId: away,
          venue: ht.homeGround,
          startsAt: startsAt.toISOString(),
          status: "scheduled",
          officials: {
            // Umpires with accounts first, in the same order as their ids, then names only.
            umpires: [umpirePool[(ri + mi) % 6], umpirePool[(ri + mi + 2) % 6]].sort((a, b) => Number(!UMPIRE_USERS[a]) - Number(!UMPIRE_USERS[b])),
            umpireUserIds: [umpirePool[(ri + mi) % 6], umpirePool[(ri + mi + 2) % 6]]
              .sort((a, b) => Number(!UMPIRE_USERS[a]) - Number(!UMPIRE_USERS[b]))
              .map((n) => UMPIRE_USERS[n])
              .filter((x): x is string => !!x),
            scorerName: "League scorer",
            // Sola Akande looks after Onikan Oval.
            ...(ht.homeGround === "Onikan Oval" ? { groundsmen: ["S. Akande"], groundsmanUserIds: ["user_sola"] } : {}),
          },
          scores: [],
          locked: false,
        };
        if (ri < playedRounds) {
          // Results so far are summaries only; featured matches get full ball events below.
          const first = rng() < 0.5 ? home : away;
          const second = first === home ? away : home;
          const r1 = 118 + Math.floor(rng() * 75);
          const w1 = 3 + Math.floor(rng() * 7);
          const chased = rng() < 0.5;
          const r2 = chased
            ? r1 + 1 + Math.floor(rng() * 5)
            : r1 - 1 - Math.floor(rng() * 40);
          const b2 = chased ? 84 + Math.floor(rng() * 34) : 120;
          const w2 = chased
            ? 2 + Math.floor(rng() * 6)
            : rng() < 0.4
              ? 10
              : 5 + Math.floor(rng() * 4);
          m.battingFirstTeamId = first;
          m.status = "completed";
          m.locked = true;
          m.toss = {
            wonByTeamId: first,
            decision: "bat",
            method: rng() < 0.6 ? "online" : "manual",
            at: startsAt.toISOString(),
          };
          m.scores = [
            { teamId: first, runs: r1, wickets: w1, balls: 120, allOut: false },
            {
              teamId: second,
              runs: r2,
              wickets: w2,
              balls: w2 === 10 ? Math.min(b2, 96 + Math.floor(rng() * 23)) : b2,
              allOut: w2 === 10,
            },
          ];
          const name = (tid: string) => teams.find((t) => t.id === tid)!.name;
          m.result = chased
            ? {
                outcome: "win",
                winnerTeamId: second,
                text: `${name(second)} won by ${10 - w2} wickets`,
              }
            : {
                outcome: "win",
                winnerTeamId: first,
                text: `${name(first)} won by ${r1 - r2} runs`,
              };
        }
        matches.push(m);
      });
    });
  };

  addFixtures(
    premierComp,
    "stage_prem_league",
    "grp_prem",
    premierComp.teamIds,
    21,
    3,
  );
  addFixtures(
    divOneComp,
    "stage_div1_groups",
    "grp_a",
    divOneComp.stages[0].groups[0].teamIds,
    20,
    2,
  );
  addFixtures(
    divOneComp,
    "stage_div1_groups",
    "grp_b",
    divOneComp.stages[0].groups[1].teamIds,
    20,
    2,
  );

  // Round 4 of the Premier League is this weekend: one match is live, one is the demo user's to score.
  const round4 = matches.filter(
    (m) => m.competitionId === premierComp.id && m.id.includes("_4_"),
  );
  const db: Db = {
    me: {
      id: "user_me",
      name: "Tunde Bakare",
      memberships: [
        { orgId: ORG_ID, role: "owner" },
        { orgId: ORG_ID, role: "leagueAdmin" },
        { orgId: ORG_ID, role: "scorer" },
        { clubId: "team_yaba", role: "clubAdmin" },
        { clubId: "team_yaba", role: "player" },
      ],
      assignedMatchIds: [],
      playerId: "player_me",
      phone: "+2348025550199",
      email: "tunde@ovalcast.app",
      phoneVerified: true,
      emailVerified: true,
      city: "Lagos",
      country: "Nigeria",
      settings: {
        dataSaver: false,
        alerts: { push: true, sms: false, whatsapp: true },
        alertTopics: {
          myMatches: true,
          myClubs: true,
          wickets: false,
          results: true,
          leagueAdmin: true,
        },
      },
    },
    users: [],
    officiating: {},
    officialInvites: [],
    deductions: [],
    payoutAccounts: {},
    settlements: [],
    subscriptions: [],
    wallets: {},
    passOffers: {},
    passes: [],
    passSales: [],
    hostPayouts: {},
    viewerCredits: {},
    rulesVersions: {},
    claims: [],
    youtube: {},
    apiClients: {},
    teamSheets: [],
    fixtureRequests: [],
    ratings: [
      { id: 'rate_1', userId: 'user_etim', raterId: 'user_ngozi', raterName: 'Ngozi Eze', role: 'umpire', matchId: undefined, scores: { decisions: 5, consistency: 4, control: 5, punctuality: 5 }, comment: 'Calm and clear all afternoon.', at: '2026-09-27T16:00:00.000Z' },
      { id: 'rate_2', userId: 'user_etim', raterId: 'user_staff', raterName: 'A club captain', role: 'umpire', matchId: undefined, scores: { decisions: 4, consistency: 4, control: 4, punctuality: 3 }, at: '2026-09-20T16:00:00.000Z' },
      { id: 'rate_3', userId: 'user_ngozi', raterId: 'user_me', raterName: 'Tunde Bakare', role: 'scorer', matchId: undefined, scores: { accuracy: 5, live: 5, punctuality: 4, communication: 5 }, comment: 'Every ball on the app before the bowler turned.', at: '2026-10-11T17:00:00.000Z' },
      { id: 'rate_4', userId: 'user_ngozi', raterId: 'user_adewale', raterName: 'Kunle Adewale', role: 'scorer', matchId: undefined, scores: { accuracy: 5, live: 4, punctuality: 5, communication: 4 }, at: '2026-10-25T17:00:00.000Z' },
      { id: 'rate_5', userId: 'user_adewale', raterId: 'user_me', raterName: 'Tunde Bakare', role: 'umpire', matchId: undefined, scores: { decisions: 4, consistency: 5, control: 4, punctuality: 4 }, at: '2026-10-18T17:00:00.000Z' },
      { id: 'rate_6', userId: 'user_garba', raterId: 'user_ngozi', raterName: 'Ngozi Eze', role: 'umpire', matchId: undefined, scores: { decisions: 3, consistency: 4, control: 3, punctuality: 4 }, at: '2026-10-04T17:00:00.000Z' },
      { id: 'rate_8', userId: 'user_femi', raterId: 'user_me', raterName: 'Tunde Bakare', role: 'coach', matchId: undefined, scores: { sessions: 4, improvement: 4, communication: 5 }, at: '2026-10-28T17:00:00.000Z' },
    ],
    featureAccess: FREE_FOR_ALL,
    registrations: [],
    transfers: [],
    notifications: [],
    posts: [],
    otherOrgs: [
      {
        id: "org_accra",
        country: "Ghana",
        currency: "GHS",
        name: "Accra Cricket Circuit",
        shortName: "Accra CC",
        city: "Accra",
        about: "Club and T20 cricket across Greater Accra.",
        founded: 2009,
        executives: [{ name: "Kwame Asante", title: "Chair" }],
        sponsors: ["Osu Bakery"],
        competitionIds: ["comp_accra_bash"],
        clubIds: elsewhere.filter((t) => t.city === "Accra").map((t) => t.id),
        honours: [],
        seasonMoves: [],
      },
      {
        id: "org_nairobi",
        country: "Kenya",
        currency: "KES",
        name: "Nairobi Cricket League",
        shortName: "Nairobi CL",
        city: "Nairobi",
        about: "Club cricket across Nairobi, from the Gymkhana to Ruaraka.",
        founded: 1999,
        executives: [{ name: "Wanjiru Kamau", title: "Chair" }],
        sponsors: ["Kilimani Motors"],
        competitionIds: ["comp_nairobi_cup"],
        clubIds: [],
        honours: [],
        seasonMoves: [],
        brandColor: "#1B3A6B",
      },
      {
        id: "org_thames",
        country: "United Kingdom",
        currency: "GBP",
        name: "Thames Valley Sunday League",
        shortName: "TVSL",
        city: "Reading",
        about:
          "Sunday afternoon league cricket for clubs across Berkshire and Oxfordshire.",
        founded: 1987,
        executives: [{ name: "Priya Sharma", title: "Fixtures secretary" }],
        sponsors: [],
        competitionIds: ["comp_thames_sunday"],
        clubIds: [],
        honours: [],
        seasonMoves: [],
        brandColor: "#7A1F2B",
      },
      {
        id: "org_freetown",
        country: "Sierra Leone",
        currency: "SLE",
        name: "Freetown Cricket Union",
        shortName: "Freetown CU",
        city: "Freetown",
        about: "Weekend cricket in the Western Area.",
        founded: 2015,
        executives: [],
        sponsors: [],
        competitionIds: [],
        clubIds: elsewhere
          .filter((t) => t.city === "Freetown")
          .map((t) => t.id),
        honours: [],
        seasonMoves: [],
      },
      {
        id: "org_banjul",
        country: "Gambia",
        currency: "GMD",
        name: "Gambia Cricket Social",
        shortName: "Gambia CS",
        city: "Serrekunda",
        about: "Social cricket on the Kombo coast.",
        founded: 2018,
        executives: [],
        sponsors: [],
        competitionIds: [],
        clubIds: elsewhere
          .filter((t) => t.city === "Serrekunda")
          .map((t) => t.id),
        honours: [],
        seasonMoves: [],
      },
      {
        id: "org_abuja",
        country: "Nigeria",
        currency: "NGN",
        name: "Abuja Cricket Circle",
        shortName: "Abuja CC",
        city: "Abuja",
        about: "Weekend league for clubs across the FCT.",
        founded: 2004,
        executives: [],
        sponsors: [],
        competitionIds: [],
        clubIds: elsewhere.filter((t) => t.city === "Abuja").map((t) => t.id),
        honours: [],
        seasonMoves: [],
      },
      {
        id: "org_ibadan",
        country: "Nigeria",
        currency: "NGN",
        name: "Ibadan Cricket League",
        shortName: "Ibadan CL",
        city: "Ibadan",
        about: "Club cricket in Oyo State.",
        founded: 1998,
        executives: [],
        sponsors: [],
        competitionIds: [],
        clubIds: elsewhere.filter((t) => t.city === "Ibadan").map((t) => t.id),
        honours: [],
        seasonMoves: [],
      },
      {
        id: "org_eko",
        country: "Nigeria",
        currency: "NGN",
        name: "Eko Cricket Social",
        shortName: "Eko Social",
        city: "Lagos",
        about:
          "Social and corporate cricket on Sundays, open to clubs from any division.",
        founded: 2011,
        executives: [{ name: "Bisi Adewunmi", title: "Organiser" }],
        sponsors: ["Marina Foods"],
        competitionIds: ["comp_eko_social", "comp_mainland_open"],
        clubIds: [],
        honours: [],
        seasonMoves: [],
      },
    ],
    entries: [
      {
        id: "entry_1",
        competitionId: "comp_t10_cup",
        teamId: "team_surulere",
        kind: "invite",
        status: "accepted",
        createdAt: new Date(now.getTime() - 6 * day).toISOString(),
        respondedAt: new Date(now.getTime() - 5 * day).toISOString(),
        payment: {
          id: "pay_1",
          entryId: "entry_1",
          amount: 50000,
          currency: "NGN",
          method: "bankTransfer",
          provider: "flutterwave",
          reference: "FLW-7Q2M9X",
          status: "paid",
          at: new Date(now.getTime() - 4 * day).toISOString(),
        },
      },
      {
        id: "entry_2",
        competitionId: "comp_t10_cup",
        teamId: "team_lekki",
        kind: "request",
        status: "accepted",
        createdAt: new Date(now.getTime() - 5 * day).toISOString(),
        respondedAt: new Date(now.getTime() - 4 * day).toISOString(),
      },
      {
        id: "entry_3",
        competitionId: "comp_t10_cup",
        teamId: "team_festac",
        kind: "request",
        status: "pending",
        message: "We would love a T10 run-out before the Super Six.",
        createdAt: new Date(now.getTime() - 2 * day).toISOString(),
      },
      {
        id: "entry_4",
        competitionId: "comp_t10_cup",
        teamId: "team_ajah",
        kind: "invite",
        status: "pending",
        createdAt: new Date(now.getTime() - 1 * day).toISOString(),
      },
      {
        id: "entry_5",
        competitionId: "comp_t10_cup",
        teamId: "team_ikorodu",
        kind: "request",
        status: "pending",
        createdAt: new Date(now.getTime() - 3600_000 * 5).toISOString(),
      },
      {
        id: "entry_6",
        competitionId: "comp_eko_social",
        teamId: "team_vi",
        kind: "invite",
        status: "accepted",
        createdAt: new Date(now.getTime() - 8 * day).toISOString(),
      },
      {
        id: "entry_7",
        competitionId: "comp_eko_social",
        teamId: "team_yaba",
        kind: "invite",
        status: "pending",
        message: "Yaba Royals, join us for Sunday cricket this season.",
        createdAt: new Date(now.getTime() - 3600_000 * 20).toISOString(),
      },
    ],
    playerInvites: [
      {
        id: "pinv_1",
        teamId: "team_yaba",
        name: "Damilola Ige",
        channel: "whatsapp",
        contact: "+234 803 555 0142",
        status: "pending",
        createdAt: new Date(now.getTime() - 2 * day).toISOString(),
      },
    ],
    org: {
      id: ORG_ID,
      country: "Nigeria",
      currency: "NGN",
      name: "CCC Lagos",
      shortName: "CCC Lagos",
      city: "Lagos",
      about:
        "Runs the Premier League and Division One for clubs across Lagos, with promotion and relegation between them every season.",
      founded: 1962,
      executives: [
        { name: "Adaeze Okoro", title: "President" },
        { name: "Kayode Fasanmi", title: "League secretary" },
        { name: "Halima Yusuf", title: "Competitions officer" },
      ],
      sponsors: ["Lagoon Paints", "Mainland Telecom", "Eko Water"],
      competitionIds: competitions.map((c) => c.id),
      clubIds: teams.map((t) => t.id),
      honours: [
        {
          season: "2025/26",
          competition: "Premier League",
          winnerTeamId: "team_ikeja",
        },
        {
          season: "2024/25",
          competition: "Premier League",
          winnerTeamId: "team_surulere",
        },
        {
          season: "2023/24",
          competition: "Premier League",
          winnerTeamId: "team_ikeja",
        },
        {
          season: "2025/26",
          competition: "Division One",
          winnerTeamId: "team_apapa",
        },
        {
          season: "2024/25",
          competition: "Division One",
          winnerTeamId: "team_lekki",
        },
      ],
      seasonMoves: [
        {
          season: "2025/26",
          teamId: "team_apapa",
          from: "Division One",
          to: "Premier League",
          kind: "promoted",
          status: "confirmed",
        },
        {
          season: "2025/26",
          teamId: "team_festac",
          from: "Premier League",
          to: "Division One",
          kind: "relegated",
          status: "confirmed",
        },
        {
          season: "2024/25",
          teamId: "team_lekki",
          from: "Division One",
          to: "Premier League",
          kind: "promoted",
          status: "confirmed",
        },
        {
          season: "2024/25",
          teamId: "team_maryland",
          from: "Premier League",
          to: "Division One",
          kind: "relegated",
          status: "confirmed",
        },
      ],
    },
    teams,
    players,
    competitions,
    matches,
    balls,
    streams: [],
    clips: [],
    stories: [],
    storyComments: [],
  };

  const xiFor = (teamId: string) =>
    players
      .filter((p) => p.teamId === teamId)
      .slice(0, 11)
      .map((p) => p.id);

  // Live match: first innings done, chase in its 10th over.
  const live = round4[0];
  live.startsAt = new Date(now.getTime() - 2.4 * 3600_000).toISOString();
  live.battingFirstTeamId = live.homeTeamId;
  live.toss = {
    wonByTeamId: live.awayTeamId,
    decision: "bowl",
    method: "online",
    at: live.startsAt,
  };
  live.playingXI = {
    [live.homeTeamId]: xiFor(live.homeTeamId),
    [live.awayTeamId]: xiFor(live.awayTeamId),
  };
  live.officials.scorerName = "Ngozi Eze";
  const liveSetup = setupFor(db, live);
  balls[live.id] = simulate(
    liveSetup,
    [],
    mulberry32(77),
    live.id,
    new Date(live.startsAt),
    (ev) => ev.filter((e) => e.innings === 2).length >= 57,
  );
  refreshFromEvents(db, live);

  // Latest full result, with every ball, for the scorecard demo.
  const featured = matches.find(
    (m) => m.competitionId === premierComp.id && m.id.includes("_3_1"),
  )!;
  featured.playingXI = {
    [featured.homeTeamId]: xiFor(featured.homeTeamId),
    [featured.awayTeamId]: xiFor(featured.awayTeamId),
  };
  balls[featured.id] = simulate(
    setupFor(db, featured),
    [],
    mulberry32(31),
    featured.id,
    new Date(featured.startsAt),
  );
  refreshFromEvents(db, featured);

  // The demo user's fixture: later today, not started.
  const mine = round4[1];
  const start = new Date(now);
  start.setHours(now.getHours() + 1, 30, 0, 0);
  mine.startsAt = start.toISOString();
  mine.officials.scorerUserId = db.me.id;
  mine.officials.scorerName = db.me.name;
  db.me.assignedMatchIds = [mine.id];

  // Streams and clips.
  live.streamId = "stream_live";
  db.streams.push(
    {
      id: "stream_live",
      matchId: live.id,
      status: "live",
      playbackUrl: "https://example.invalid/hls/live.m3u8",
      viewers: 312,
      latencySeconds: 5,
      source: "phone",
      streamer: "Surulere Strikers media",
    },
    {
      id: "stream_featured",
      matchId: featured.id,
      status: "ended",
      playbackUrl: "https://example.invalid/hls/featured.m3u8",
      viewers: 0,
      latencySeconds: 6,
      source: "encoder",
      streamer: "CCC Lagos TV",
    },
  );
  featured.streamId = "stream_featured";
  for (const m of [live, featured]) {
    const setup = setupFor(db, m);
    for (const e of balls[m.id]) {
      const kind = e.wicket
        ? "wicket"
        : e.boundary && e.bat === 6
          ? "six"
          : e.boundary && e.bat === 4
            ? "four"
            : null;
      if (!kind) continue;
      const batter = setup.teams
        .flatMap((t) => t.players)
        .find((p) => p.id === (e.wicket?.playerOutId ?? e.strikerId))!;
      const legalBefore = balls[m.id].filter(
        (x) =>
          x.innings === e.innings &&
          x.seq < e.seq &&
          (!x.extra || x.extra.kind === "bye" || x.extra.kind === "legBye"),
      ).length;
      db.clips.push({
        id: `clip_${e.id}`,
        matchId: m.id,
        ballEventId: e.id,
        kind,
        title:
          kind === "wicket"
            ? `${batter.shortName} out`
            : `${batter.shortName} hits a ${kind}`,
        over: `${Math.floor(legalBefore / 6)}.${(legalBefore % 6) + 1}`,
        durationSeconds: kind === "six" ? 14 : 11,
      });
    }
  }

  // Club staff: the captain is the first player; every club has a coach and a manager.
  const staffNames = [
    "Coach Femi Adeyemi",
    "Sola Akande",
    "Ngozi Okafor",
    "Tayo Bello",
    "Kemi Ojo",
    "Uche Nwosu",
    "Bisi Lawal",
    "Chike Eze",
  ];
  teams.forEach((t, i) => {
    const squad = players.filter((p) => p.teamId === t.id);
    const staff: StaffMember[] = [
      {
        id: `staff_${t.id}_cap`,
        name: squad[0]?.name ?? "Captain",
        role: "captain",
        playerId: squad[0]?.id,
      },
      {
        id: `staff_${t.id}_vc`,
        name: squad[4]?.name ?? "Vice-captain",
        role: "viceCaptain",
        playerId: squad[4]?.id,
      },
      {
        id: `staff_${t.id}_coach`,
        name: staffNames[i % staffNames.length],
        role: "coach",
        phone: "+234 803 555 01" + String(10 + i),
      },
      {
        id: `staff_${t.id}_mgr`,
        name: staffNames[(i + 3) % staffNames.length],
        role: "manager",
      },
    ];
    t.staff = staff;
  });
  const yaba = teams.find((t) => t.id === "team_yaba")!;
  yaba.staff.push(
    {
      id: "staff_yaba_scorer",
      name: "Tunde Bakare",
      role: "scorer",
      playerId: "player_me",
    },
    {
      id: "staff_yaba_physio",
      name: "Dr Amaka Obi",
      role: "physio",
      phone: "+234 809 555 0177",
    },
  );

  const hoursAgo = (h: number) =>
    new Date(now.getTime() - h * 3600_000).toISOString();
  db.notifications = [
    {
      id: "n1",
      userId: "user_me",
      kind: "transfer",
      title: "Lekki Waves want David Agu",
      body: "They asked for one of your Yaba Royals players. Release or turn down.",
      at: hoursAgo(9),
      read: false,
      link: {
        pathname: "/competition/[id]",
        params: { id: "comp_prem_2627", tab: "transfers" },
      },
    },
    {
      id: "n2",
      userId: "user_me",
      kind: "invite",
      title: "Eko Social League invited Yaba Royals",
      body: "Sunday cricket this season. Accept or decline for your club.",
      at: hoursAgo(20),
      read: false,
      link: {
        pathname: "/team/[id]",
        params: { id: "team_yaba", tab: "leagues" },
      },
    },
    {
      id: "n3",
      userId: "user_me",
      kind: "entry",
      title: "Ikorodu Bulls want to join the T10 Cup",
      body: "Accept or decline. Their players are in Division One.",
      at: hoursAgo(5),
      read: false,
      link: {
        pathname: "/competition/[id]",
        params: { id: "comp_t10_cup", tab: "clubs" },
      },
    },
    {
      id: "n4",
      userId: "user_me",
      kind: "match",
      title: "You are scoring Lekki Waves v Ikeja Titans",
      body: "Today at Lekki Sports Field. Run the toss from the match page.",
      at: hoursAgo(3),
      read: true,
      link: { pathname: "/match/[id]", params: { id: "m_prem_grp_prem_4_2" } },
    },
    {
      id: "n5",
      userId: "user_me",
      kind: "result",
      title: "Surulere Strikers won by 17 runs",
      body: "Obinna Okonkwo took 3/36 against Lekki Waves.",
      at: hoursAgo(26),
      read: true,
      link: { pathname: "/match/[id]", params: { id: featured.id } },
    },
  ];
  db.posts = [
    {
      id: "post1",
      kind: "clubWantsPlayers",
      regionId: "lagos",
      title: "Yaba Royals need two seam bowlers",
      body: "Premier League side, nets Tuesday and Thursday evenings at Onikan. All levels welcome to trial.",
      authorName: "Tunde Bakare",
      teamId: "team_yaba",
      whatsapp: "2348025550199",
      createdAt: hoursAgo(30),
    },
    {
      id: "post2",
      kind: "playerWantsClub",
      regionId: "lagos",
      title: "Keeper-batter new to Lagos",
      body: "Played two seasons in Ibadan. Free on Saturdays, live in Ikeja.",
      authorName: "Segun Adebayo",
      whatsapp: "2348035550123",
      createdAt: hoursAgo(14),
    },
    {
      id: "post3",
      kind: "friendlyWanted",
      regionId: "lagos",
      title: "T20 friendly, Sunday 11 Oct",
      body: "Festac Falcons looking for a side for a warm-up at Festac Town Field. We provide balls.",
      authorName: "Festac Falcons",
      teamId: "team_festac",
      whatsapp: "2348055550188",
      when: new Date(now.getTime() + 10 * day).toISOString(),
      createdAt: hoursAgo(8),
    },
    {
      id: "post4",
      kind: "needUmpire",
      regionId: "lagos",
      title: "Umpire needed, Division One, Saturday",
      body: "Agege Stadium Annex, 10:00 start. Match fee paid.",
      authorName: "Agege Eagles",
      teamId: "team_agege",
      whatsapp: "2348065550111",
      when: new Date(now.getTime() + 2 * day).toISOString(),
      createdAt: hoursAgo(4),
    },
    {
      id: "post5",
      kind: "groundAvailable",
      regionId: "lagos",
      title: "Lekki Sports Field free Sunday mornings",
      body: "Matting wicket, changing rooms. Book for a friendly or nets.",
      authorName: "Lekki Waves",
      teamId: "team_lekki",
      whatsapp: "2348075550166",
      createdAt: hoursAgo(50),
    },
    {
      id: "post6",
      kind: "needScorer",
      regionId: "accra",
      title: "Scorer for the Accra T20 Bash",
      body: "Learn the Ovalcast app in ten minutes. Transport covered.",
      authorName: "Accra Cricket Circuit",
      whatsapp: "233245550144",
      createdAt: hoursAgo(12),
    },
    {
      id: "post7",
      kind: "clubWantsPlayers",
      regionId: "abuja",
      title: "Wuse Warriors want a spinner",
      body: "Saturday cricket at the Old Parade Ground.",
      authorName: "Wuse Warriors",
      teamId: "team_wuse",
      whatsapp: "2348095550133",
      createdAt: hoursAgo(40),
    },
  ];

  // League squads: every club's players are registered for each league it is in.
  for (const c of competitions) {
    for (const teamId of c.teamIds) {
      for (const p of players.filter((x) => x.teamId === teamId)) {
        db.registrations.push({
          id: `reg_${c.id}_${p.id}`,
          competitionId: c.id,
          playerId: p.id,
          teamId,
          primary: true,
          since: c.startsOn,
          status: "active",
        });
      }
    }
  }

  // Premier League transfer window is open: one move done, three waiting (one on Tunde, the
  // signed-in demo player, to agree to).
  const pl = (team: string, n: number) =>
    players.find((p) => p.id === `team_${team}_p${n}`)!;
  const moved = pl("apapa", 12);
  const ago = (d: number) => new Date(now.getTime() - d * day).toISOString();
  db.transfers.push(
    {
      id: "tr_1",
      competitionId: premierComp.id,
      playerId: moved.id,
      fromTeamId: "team_apapa",
      toTeamId: "team_vi",
      kind: "move",
      status: "approved",
      createdAt: ago(3),
      startedBy: "club",
      history: [
        { status: "awaitingPlayer", at: ago(3), by: "requestingClub" },
        { status: "awaitingClub", at: ago(2.8), by: "player" },
        { status: "awaitingLeague", at: ago(2.5), by: "releasingClub" },
        { status: "approved", at: ago(2), by: "league" },
      ],
    },
    {
      id: "tr_2",
      competitionId: premierComp.id,
      playerId: pl("ikeja", 12).id,
      fromTeamId: "team_ikeja",
      toTeamId: "team_surulere",
      kind: "move",
      status: "awaitingLeague",
      note: "Moving closer to Surulere for work.",
      createdAt: ago(1.5),
      startedBy: "player",
      history: [
        { status: "awaitingNewClub", at: ago(1.5), by: "player" },
        { status: "awaitingClub", at: ago(1.3), by: "requestingClub" },
        { status: "awaitingLeague", at: ago(1), by: "releasingClub" },
      ],
    },
    {
      id: "tr_3",
      competitionId: premierComp.id,
      playerId: pl("yaba", 13).id,
      fromTeamId: "team_yaba",
      toTeamId: "team_lekki",
      kind: "move",
      status: "awaitingClub",
      note: "Not getting games at Yaba, we can offer a regular place.",
      createdAt: ago(0.4),
      startedBy: "club",
      history: [
        { status: "awaitingPlayer", at: ago(0.4), by: "requestingClub" },
        { status: "awaitingClub", at: ago(0.3), by: "player", note: "Recorded by the league: signed form at training." },
      ],
    },
    {
      id: "tr_4",
      competitionId: premierComp.id,
      playerId: "player_me",
      fromTeamId: "team_yaba",
      toTeamId: "team_surulere",
      kind: "move",
      status: "awaitingPlayer",
      note: "We need an all-rounder for the second half of the season.",
      createdAt: ago(0.2),
      startedBy: "club",
      history: [{ status: "awaitingPlayer", at: ago(0.2), by: "requestingClub" }],
    },
  );
  const movedReg = db.registrations.find(
    (r) => r.competitionId === premierComp.id && r.playerId === moved.id,
  )!;
  movedReg.status = "ended";
  db.registrations.push({
    id: "reg_tr_1",
    competitionId: premierComp.id,
    playerId: moved.id,
    teamId: "team_vi",
    primary: true,
    since: ago(2),
    status: "active",
  });
  moved.teamId = "team_vi";
  // Keep him at the end of his new squad so the regular first XI is unchanged.
  players.splice(players.indexOf(moved), 1);
  players.push(moved);

  // ---- People: officials, a groundsman and coaches, each with an account (password cricket123).
  const person = (
    id: string,
    name: string,
    phone: string,
    email: string,
    city: string,
  ): User => ({
    id,
    name,
    phone,
    email,
    phoneVerified: true,
    emailVerified: true,
    city,
    country: phone.startsWith("+233")
      ? "Ghana"
      : phone.startsWith("+232")
        ? "Sierra Leone"
        : phone.startsWith("+220")
          ? "Gambia"
          : "Nigeria",
    memberships: [],
    assignedMatchIds: [],
    settings: {
      dataSaver: true,
      alerts: { push: true, sms: true, whatsapp: true },
      alertTopics: {
        myMatches: true,
        myClubs: true,
        wickets: false,
        results: true,
        leagueAdmin: true,
      },
    },
  });
  const cert = (
    id: string,
    role: OfficiatingProfile["roles"][0],
    title: string,
    issuer: string,
    year: number,
    status: "pending" | "verified" = "verified",
  ) => ({
    id,
    role,
    title,
    issuer,
    year,
    fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
    fileUrl: `demo://certificates/${id}.pdf`,
    status,
    uploadedAt: new Date(now.getTime() - 60 * day).toISOString(),
  });
  const people: [User, OfficiatingProfile][] = [
    [
      person(
        "user_ngozi",
        "Ngozi Eze",
        "+2348035550111",
        "ngozi@ovalcast.app",
        "Lagos",
      ),
      {
        roles: ["scorer"],
        available: true,
        days: ["sat", "sun"],
        travelKm: 25,
        fee: 5000,
        grounds: [],
        bio: "Scoring Lagos league cricket since 2019. Comfortable with Ovalcast, paper books and the PA.",
        certificates: [
          cert(
            "cert_ngozi_1",
            "scorer",
            "Level 1 Scorer",
            "Nigeria Cricket Federation",
            2021,
          ),
          cert(
            "cert_ngozi_2",
            "scorer",
            "Advanced Scoring",
            "ICC Africa",
            2024,
          ),
        ],
      },
    ],
    [
      person(
        "user_adewale",
        "Kunle Adewale",
        "+2348035550122",
        "kunle@ovalcast.app",
        "Lagos",
      ),
      {
        roles: ["umpire"],
        available: true,
        days: ["sat", "sun"],
        travelKm: 40,
        fee: 10000,
        grounds: [],
        bio: "Panel umpire for CCC Lagos. Stood in the 2025/26 Premier League final.",
        certificates: [
          cert(
            "cert_adewale_1",
            "umpire",
            "Level 2 Umpire",
            "Nigeria Cricket Federation",
            2020,
          ),
          cert(
            "cert_adewale_2",
            "umpire",
            "Laws of Cricket 2026 update",
            "MCC",
            2026,
          ),
        ],
      },
    ],
    [
      person(
        "user_etim",
        "Joseph Etim",
        "+2348035550133",
        "joseph@ovalcast.app",
        "Lagos",
      ),
      {
        roles: ["umpire", "scorer"],
        available: true,
        days: ["sat"],
        travelKm: 20,
        fee: 7500,
        grounds: [],
        bio: "Umpire on Saturdays, and happy to score on short notice.",
        certificates: [
          cert(
            "cert_etim_1",
            "umpire",
            "Level 1 Umpire",
            "Nigeria Cricket Federation",
            2023,
          ),
        ],
      },
    ],
    [
      person(
        "user_garba",
        "Musa Garba",
        "+2348035550144",
        "musa@ovalcast.app",
        "Lagos",
      ),
      {
        roles: ["umpire"],
        available: false,
        days: ["sun"],
        travelKm: 15,
        grounds: [],
        bio: "Away until November.",
        certificates: [
          cert(
            "cert_garba_1",
            "umpire",
            "Level 1 Umpire",
            "Nigeria Cricket Federation",
            2018,
          ),
        ],
      },
    ],
    [
      person(
        "user_sola",
        "Sola Akande",
        "+2348035550155",
        "sola@ovalcast.app",
        "Lagos",
      ),
      {
        roles: ["groundsman"],
        available: true,
        days: ["mon", "wed", "fri", "sat"],
        travelKm: 10,
        grounds: ["Onikan Oval", "Surulere Ground"],
        bio: "Head groundsman at Onikan Oval. Prepares turf and matting pitches; can advise on covers in the rainy season.",
        certificates: [
          cert(
            "cert_sola_1",
            "groundsman",
            "Turf Pitch Preparation",
            "Institute of Groundsmanship",
            2022,
          ),
          cert(
            "cert_sola_2",
            "groundsman",
            "Drainage and Outfield Care",
            "Lagos State Sports Commission",
            2025,
            "pending",
          ),
        ],
      },
    ],
    [
      person(
        "user_femi",
        "Femi Adeyemi",
        "+2348035550166",
        "femi@ovalcast.app",
        "Lagos",
      ),
      {
        roles: ["coach"],
        available: true,
        days: ["tue", "thu", "sat"],
        travelKm: 30,
        fee: 15000,
        grounds: ["Onikan Oval"],
        bio: "Batting and wicketkeeping coach. Runs junior nets at Onikan on Tuesday and Thursday evenings.",
        certificates: [
          cert("cert_femi_1", "coach", "Level 2 Coach", "ICC Africa", 2019),
        ],
      },
    ],
    [
      person(
        "user_kwame",
        "Kwame Boateng",
        "+233245550177",
        "kwame@ovalcast.app",
        "Accra",
      ),
      {
        roles: ["umpire", "scorer"],
        available: true,
        days: ["sat", "sun"],
        travelKm: 30,
        fee: 150,
        grounds: [],
        bio: "Umpire and scorer for the Accra T20 Bash.",
        certificates: [
          cert(
            "cert_kwame_1",
            "umpire",
            "Level 1 Umpire",
            "Ghana Cricket Association",
            2022,
          ),
        ],
      },
    ],
  ];
  db.users = [db.me, ...people.map(([u]) => u)];
  // Ovalcast's own staff: the staff console, never a client role.
  db.users.push({
    ...person(
      "user_staff",
      "Ada Okonkwo",
      "+2348095550100",
      "ada@ovalcast.app",
      "Lagos",
    ),
    staff: true,
  });
  db.me.follows = {
    teamIds: ["team_lekki"],
    playerIds: [],
    competitionIds: [],
  };
  for (const [u, o] of people) db.officiating[u.id] = o;
  db.officiating[db.me.id] = {
    roles: ["scorer"],
    available: true,
    days: ["sat", "sun"],
    travelKm: 20,
    grounds: [],
    bio: "League admin at CCC Lagos and Yaba Royals all-rounder. I score when I’m not playing.",
    certificates: [
      cert(
        "cert_me_1",
        "scorer",
        "Level 1 Scorer",
        "Nigeria Cricket Federation",
        2025,
        "pending",
      ),
    ],
  };
  // Coach Femi is listed as coach at a few clubs; link those staff entries to his account.
  for (const t of teams)
    for (const st of t.staff)
      if (st.name === "Coach Femi Adeyemi") {
        st.userId = "user_femi";
        st.name = "Femi Adeyemi";
      }
  const yabaScorer = yaba.staff.find((x) => x.role === "scorer");
  if (yabaScorer) yabaScorer.userId = db.me.id;

  // Who scored what: Ngozi has the live match; Tunde scored the featured result and a few others.
  live.officials.scorerUserId = "user_ngozi";
  featured.officials.scorerUserId = db.me.id;
  featured.officials.scorerName = db.me.name;
  matches
    .filter(
      (m) => m.status === "completed" && m.competitionId === divOneComp.id,
    )
    .slice(0, 3)
    .forEach((m) => {
      m.officials.scorerUserId = db.me.id;
      m.officials.scorerName = db.me.name;
    });
  matches
    .filter((m) => m.status === "completed" && !m.officials.scorerUserId)
    .forEach((m, i) => {
      if (i % 2 === 0) {
        m.officials.scorerUserId = "user_ngozi";
        m.officials.scorerName = "Ngozi Eze";
      }
    });

  // A friendly Festac Falcons have set up, inviting Tunde to score.
  const friendlyStart = new Date(now.getTime() + 3 * day);
  friendlyStart.setHours(11, 0, 0, 0);
  const friendly: Match = {
    id: "m_friendly_festac",
    title: "Friendly",
    homeTeamId: "team_festac",
    awayTeamId: "team_agege",
    venue: "Festac Town Field",
    startsAt: friendlyStart.toISOString(),
    status: "scheduled",
    officials: { umpires: ["J. Etim"], umpireUserIds: ["user_etim"] },
    scores: [],
    locked: false,
    friendly: true,
    createdBy: "user_femi",
    conditions: {
      ...T20,
      oversPerInnings: 25,
      maxOversPerBowler: 5,
      powerplayOvers: 7,
    },
  };
  matches.push(friendly);
  db.officialInvites.push({
    id: "oinv_1",
    matchId: friendly.id,
    userId: db.me.id,
    userName: db.me.name,
    role: "scorer",
    invitedBy: "user_femi",
    invitedByName: "Femi Adeyemi",
    status: "pending",
    note: "Warm-up before the Super Six. Lunch provided.",
    createdAt: new Date(now.getTime() - 2 * 3600_000).toISOString(),
  });
  db.notifications.push({
    id: "n6",
    userId: db.me.id,
    kind: "official",
    title: "Femi Adeyemi invited you to score",
    body: "Festac Falcons v Agege Eagles, a 25-over friendly at Festac Town Field. Accept or decline on the match.",
    at: new Date(now.getTime() - 2 * 3600_000).toISOString(),
    read: false,
    link: { pathname: "/match/[id]", params: { id: friendly.id } },
  });

  // Discipline: two deductions this season.
  const apapaLoss = matches.find(
    (m) =>
      m.competitionId === premierComp.id &&
      m.status === "completed" &&
      (m.homeTeamId === "team_apapa" || m.awayTeamId === "team_apapa"),
  );
  db.deductions.push(
    {
      id: "ded_1",
      competitionId: premierComp.id,
      teamId: "team_apapa",
      points: 2,
      reason: "ineligiblePlayer",
      note: "Fielded a player not registered for the Premier League.",
      matchId: apapaLoss?.id,
      status: "active",
      by: db.me.id,
      byName: db.me.name,
      at: new Date(now.getTime() - 9 * day).toISOString(),
    },
    {
      id: "ded_2",
      competitionId: divOneComp.id,
      teamId: "team_agege",
      points: 1,
      reason: "slowOverRate",
      note: "Two overs short at the scheduled close.",
      status: "active",
      by: db.me.id,
      byName: db.me.name,
      at: new Date(now.getTime() - 5 * day).toISOString(),
    },
  );

  // Entry fees for the two running leagues: most paid online, one in cash, two still owed.
  const methods: Payment["method"][] = [
    "bankTransfer",
    "card",
    "ussd",
    "bankTransfer",
    "card",
    "bankTransfer",
  ];
  const ref = (i: number) =>
    `FLW-${(0x4a7c1 + i * 7919).toString(36).toUpperCase().slice(-6)}`;
  let k = 0;
  for (const c of [premierComp, divOneComp]) {
    c.teamIds.forEach((teamId, i) => {
      const accepted = new Date(
        new Date(c.startsOn).getTime() - (40 - i) * day,
      );
      const id = `entry_${c.id}_${teamId}`;
      const owes =
        c.id === divOneComp.id &&
        (teamId === "team_agege" || teamId === "team_ikorodu");
      const cash = c.id === divOneComp.id && i === 1;
      // One payment came in this morning, so the demo always has money on its way.
      const at =
        c.id === divOneComp.id && i === c.teamIds.length - 1
          ? new Date(now.getTime() - 2 * 3600_000)
          : new Date(
              accepted.getTime() + (2 + (i % 5)) * day + 3600_000 * (9 + i),
            );
      db.entries.push({
        id,
        competitionId: c.id,
        teamId,
        kind: i % 3 === 0 ? "request" : "invite",
        status: "accepted",
        createdAt: new Date(accepted.getTime() - 2 * day).toISOString(),
        respondedAt: accepted.toISOString(),
        payment: owes
          ? undefined
          : {
              id: `pay_${c.id}_${teamId}`,
              entryId: id,
              amount: c.entryFee,
              currency: "NGN",
              method: cash ? "cash" : methods[k % methods.length],
              provider: cash ? "cash" : "flutterwave",
              reference: cash
                ? `CASH-${(i + 11).toString(36).toUpperCase()}7Q`
                : ref(k),
              status: "paid",
              at: at.toISOString(),
            },
      });
      k += 1;
    });
  }

  // The business model. CCC Lagos is on the Organisation plan; the other bodies run on their admins' own plans.
  db.org.plan = "organisation";
  premierComp.tier = 1;
  divOneComp.tier = 2;
  db.org.kind = "league";
  for (const o of db.otherOrgs)
    o.kind =
      o.name.toLowerCase().includes("social") ||
      o.name.toLowerCase().includes("open")
        ? "festival"
        : "league";
  for (const o of db.otherOrgs) o.plan = "free";
  db.subscriptions.push({
    id: "sub_femi",
    userId: "user_femi",
    plan: "pro",
    interval: "monthly",
    status: "active",
    currency: "NGN",
    amount: 1500,
    startedAt: new Date(now.getTime() - 40 * day).toISOString(),
    renewsAt: new Date(now.getTime() + 20 * day).toISOString(),
    cancelAtPeriodEnd: false,
    provider: "flutterwave",
  });
  db.wallets[db.me.id] = {
    balance: 1500,
    currency: "NGN",
    entries: [
      {
        id: "w1",
        kind: "topUp",
        amount: 2500,
        note: "Top-up by bank transfer",
        reference: "FLW-TOP4Q1",
        at: new Date(now.getTime() - 12 * day).toISOString(),
      },
      {
        id: "w2",
        kind: "pass",
        amount: -1000,
        note: "Match pass, Ikoyi v Lekki",
        reference: "PASS-8K2",
        at: new Date(now.getTime() - 9 * day).toISOString(),
      },
    ],
  };
  // Femi's Surulere media team streams the live match as a paid stream, ₦1,000 a pass.
  db.passOffers[live.id] = {
    price: 1000,
    hostUserId: "user_femi",
    hostName: "Surulere Strikers media",
  };
  // Tunde hosted CCC Lagos TV's earlier streams, so he has earnings and a payout history.
  const sale = (matchId: string, passes: number, daysAgo: number) => {
    const gross = passes * 1000;
    const fees = Math.round(gross * 0.0215);
    return {
      matchId,
      hostUserId: db.me.id,
      passes,
      gross,
      fees,
      host: Math.round((gross - fees) * 0.7),
      at: new Date(now.getTime() - daysAgo * day).toISOString(),
    };
  };
  const hosted = matches
    .filter(
      (m) => m.status === "completed" && m.competitionId === premierComp.id,
    )
    .slice(0, 3);
  db.passSales.push(
    sale(featured.id, 41, 2),
    ...hosted.map((m, i) => sale(m.id, [63, 38, 52][i], 9 + i * 7)),
  );
  db.hostPayouts[db.me.id] = [
    {
      id: "hp_1",
      amount: db.passSales.slice(2).reduce((s, x) => s + x.host, 0),
      status: "paid",
      reference: "TRF-9QX21",
      at: new Date(now.getTime() - 4 * day).toISOString(),
    },
  ];
  db.viewerCredits[ORG_ID] = {
    orgId: ORG_ID,
    hoursLeft: 164,
    hoursUsed: 236,
    purchases: [
      {
        id: "vc_1",
        hours: 400,
        price: 48000,
        reference: "FLW-VC77A",
        at: new Date(now.getTime() - 30 * day).toISOString(),
      },
    ],
  };

  // CCC Lagos has its website connected through the partner API, and its YouTube channel saved.
  db.youtube[ORG_ID] = true;
  db.org.youtubeConnected = true;
  db.apiClients[ORG_ID] = [
    {
      id: "api_ccc_site",
      name: "CCC Lagos website",
      keyPrefix: "ovl_live_7Kq2",
      sandbox: false,
      createdAt: new Date(now.getTime() - 50 * day).toISOString(),
      lastUsedAt: new Date(now.getTime() - 3600_000).toISOString(),
      requestsThisMonth: 18240,
      webhooks: [
        {
          id: "wh_1",
          url: "https://ccclagos.example/hooks/ovalcast",
          events: ["match.started", "wicket", "match.completed"],
          active: true,
        },
      ],
    },
  ];
  // A Yaba Royals regular asks to claim matches scored under a typed-in name.
  db.claims.push({
    id: "claim_1",
    playerId: players.find(
      (p) => p.teamId === "team_yaba" && p.id !== "player_me",
    )!.id,
    playerName: players.find(
      (p) => p.teamId === "team_yaba" && p.id !== "player_me",
    )!.name,
    teamId: "team_yaba",
    userId: "user_adewale",
    userName: "Kunle Adewale",
    status: "pending",
    note: "That was me before I had an account.",
    createdAt: new Date(now.getTime() - day).toISOString(),
  });

  // CCC Lagos is paid into its GTBank account the next working day. The other leagues have not set one up.
  db.payoutAccounts[ORG_ID] = {
    orgId: ORG_ID,
    kind: "bank",
    institution: "GTBank",
    institutionCode: "058",
    last4: "4821",
    accountName: "CRICKET CLUB OF LAGOS",
    schedule: "auto",
    verifiedAt: new Date(now.getTime() - 70 * day).toISOString(),
    changedByName: db.me.name,
  };
  settleDue(db, ORG_ID, now);

  // The feed: training, a result, a milestone and matchday news from clubs, players and officials.
  const lastYaba = matches
    .filter((m) => m.status === "completed" && (m.homeTeamId === "team_yaba" || m.awayTeamId === "team_yaba"))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  const story = (id: string, authorId: string, authorName: string, kind: StoryKind, text: string, h: number, tags: { teamId?: string; matchId?: string; competitionId?: string } = {}, likedBy: string[] = []) => ({
    id, authorId, authorName, kind, text, photoUrls: [], ...tags, likes: likedBy.length, comments: 0, likedBy, createdAt: hoursAgo(h),
  });
  db.stories = [
    story("story_1", "user_me", "Tunde Bakare", "training", "Tuesday nets at Onikan. Worked on yorkers at the death, twelve overs each for the seamers. Thursday is fielding.", 6, { teamId: "team_yaba" }, ["user_ngozi", "user_sola"]),
    ...(lastYaba
      ? [story("story_2", "user_ngozi", "Ngozi Eze", "highlight", `Scored this one ball by ball: ${lastYaba.result?.text ?? "a close finish"}. Full scorecard on the match page.`, 20, { matchId: lastYaba.id, competitionId: lastYaba.competitionId, teamId: "team_yaba" }, ["user_me"])]
      : []),
    story("story_3", "user_sola", "Sola Akande", "matchday", "Square cut and rolled at Onikan Oval. Covers on overnight, the pitch will be firm for Saturday's 10:00 start.", 30, {}, ["user_garba"]),
    story("story_4", "user_garba", "Musa Garba", "milestone", "My 50th match as an umpire this weekend. Thank you to every club that has had me.", 48, {}, ["user_me", "user_ngozi", "user_sola", "user_adewale"]),
    story("story_5", "user_me", "Tunde Bakare", "news", "Squads for the second half of the season are in. Two new seamers from the trials, welcome both.", 72, { teamId: "team_yaba", competitionId: premierComp.id }),
  ];
  db.storyComments = [
    { id: "cmt_1", storyId: "story_4", authorId: "user_me", authorName: "Tunde Bakare", text: "Well deserved. Always fair.", createdAt: hoursAgo(46) },
    { id: "cmt_2", storyId: "story_1", authorId: "user_sola", authorName: "Sola Akande", text: "Nets will be ready from 4.", createdAt: hoursAgo(5) },
  ];
  for (const st of db.stories) st.comments = db.storyComments.filter((c) => c.storyId === st.id).length;

  return db;
}

/** Pays out whatever the provider owes a league by now, as the provider's settlement run would. */
export function settleDue(db: Db, orgId: string, now = new Date()) {
  const account = db.payoutAccounts[orgId];
  if (!account) return;
  const org = [db.org, ...db.otherOrgs].find((o) => o.id === orgId)!;
  const comps = new Set(
    db.competitions.filter((c) => c.orgId === orgId).map((c) => c.id),
  );
  const payments = db.entries
    .filter((e) => comps.has(e.competitionId) && e.payment?.status === "paid")
    .map((e) => e.payment!);
  for (const g of dueSettlements(
    payments,
    org.currency,
    account.schedule,
    now,
    account.holdUntil ? new Date(account.holdUntil) : undefined,
  )) {
    const id = `stl_${orgId}_${g.on.getTime().toString(36)}`;
    db.settlements.push({
      id,
      orgId,
      amount: g.amount,
      currency: org.currency,
      paymentCount: g.paymentIds.length,
      status: "paid",
      reference: `STL-${g.on.getTime().toString(36).toUpperCase().slice(-7)}`,
      accountLabel: `${account.institution} ending ${account.last4}`,
      kind: "scheduled",
      createdAt: g.on.toISOString(),
      paidAt: g.on.toISOString(),
    });
    for (const p of payments)
      if (g.paymentIds.includes(p.id)) p.settlementId = id;
  }
}
