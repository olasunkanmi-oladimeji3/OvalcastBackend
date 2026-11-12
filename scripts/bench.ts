import 'dotenv/config';
// Thousands of simulated people come from this one machine: send the trusted-caller token so
// the test measures the server, not its rate limits.
if (process.env.INTERNAL_API_TOKEN) {
  const plain = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => plain(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-Internal-Token': process.env.INTERNAL_API_TOKEN! } })) as typeof fetch;
}
// Times every read the apps make: cold (caches emptied), warm, signed out and signed in.
//   npm run bench                 all routes
//   npm run bench -- --slow 20    only routes slower than 20 ms cold
// Run against a seeded database with the server running.

const BASE = process.env.BENCH_BASE ?? 'http://localhost:4000';
const API = `${BASE}/api/v1`;
const arg = (n: string, d: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const SLOW = Number(arg('slow', '0'));
const WARM = 20;

const M = 'm_prem_grp_prem_1_1'; // a finished match, ball by ball
const ROUTES: { path: string; auth?: boolean }[] = [
  { path: '/competitions' }, { path: '/competitions/comp_prem_2627' }, { path: '/competitions/comp_prem_2627/standings' }, { path: '/competitions/comp_prem_2627/leaderboards' },
  { path: '/competitions/comp_prem_2627/deductions' }, { path: '/competitions/comp_prem_2627/rules' },
  { path: '/entries?competitionId=comp_t10_cup' }, { path: '/registrations?competitionId=comp_prem_2627' }, { path: '/transfers?competitionId=comp_prem_2627' },
  { path: '/matches' }, { path: '/matches?status=live,inningsBreak' }, { path: `/matches/${M}` }, { path: `/matches/${M}/balls` }, { path: `/matches/${M}/eligibility` }, { path: `/matches/${M}/lineups` },
  { path: `/matches/${M}/clips` }, { path: `/matches/${M}/pass-offer` },
  { path: '/teams' }, { path: '/teams/team_vi' }, { path: '/teams/team_vi/players' }, { path: '/players/team_vi_p1/career' }, { path: '/players/team_vi_p1/milestones' }, { path: '/players/team_vi_p1/shots' },
  { path: '/organisations' }, { path: '/organisations/org_ccc' }, { path: '/regions' }, { path: '/regions/lagos/leaders' }, { path: '/regions/nearest?lat=6.45&lon=3.4' },
  { path: '/search?q=lek' }, { path: '/community?regionId=lagos' }, { path: '/streams' }, { path: '/streams/stream_live' }, { path: '/officials' }, { path: '/people/user_etim' }, { path: '/feature-access' },
  // Signed in.
  { path: '/me', auth: true }, { path: '/me/plan', auth: true }, { path: '/me/wallet', auth: true }, { path: '/me/earnings', auth: true }, { path: '/notifications', auth: true }, { path: '/me/official-invites', auth: true },
  { path: '/people/user_etim', auth: true }, { path: '/players/team_vi_p1/career', auth: true }, { path: '/teams/team_vi/players', auth: true }, { path: `/matches/${M}/pass-offer`, auth: true },
  { path: '/organisations/org_ccc/finance', auth: true }, { path: '/organisations/org_ccc/admins', auth: true }, { path: '/competitions/comp_prem_2627/fixture-requests', auth: true },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function time(path: string, token?: string) {
  const t = performance.now();
  const r = await fetch(API + path, { headers: { 'Accept-Encoding': 'gzip', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const body = await r.arrayBuffer();
  return { ms: performance.now() - t, status: r.status, kb: body.byteLength / 1024, cache: r.headers.get('x-cache') ?? '' };
}

async function main() {
  const { session } = (await (await fetch(`${API}/auth/sign-in`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'tunde@ovalcast.app', password: 'cricket123' }) })).json()) as { session: { token: string } };
  const rows: { route: string; status: number; coldMs: number; warmP50: number; warmP95: number; kb: number; cache: string }[] = [];
  for (const r of ROUTES) {
    await fetch(`${BASE}/health/flush`, { method: 'POST' });
    const token = r.auth ? session.token : undefined;
    if (token) await time('/me', token); // the session itself is not what's being timed
    const cold = await time(r.path, token);
    const warm: number[] = [];
    let last = cold;
    for (let i = 0; i < WARM; i++) warm.push((last = await time(r.path, token)).ms);
    rows.push({ route: `${r.auth ? '[in] ' : ''}${r.path}`, status: cold.status, coldMs: Math.round(cold.ms), warmP50: +pct(warm, 50).toFixed(1), warmP95: +pct(warm, 95).toFixed(1), kb: +last.kb.toFixed(1), cache: last.cache });
  }
  rows.sort((a, b) => b.coldMs - a.coldMs);
  console.table(rows.filter((r) => r.coldMs >= SLOW));
  const bad = rows.filter((r) => r.status >= 400);
  if (bad.length) console.log('Not OK:', bad.map((r) => `${r.route} ${r.status}`).join(', '));
}

main();
