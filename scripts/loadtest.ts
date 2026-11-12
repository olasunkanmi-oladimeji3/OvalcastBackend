// Live-match load test: one scorer enters a ball every couple of seconds while many
// people watch the same match. Reports what viewers see and what it costs Postgres.
//
//   npm run loadtest -- --viewers 1000 --seconds 60 --mode sse
//   npm run loadtest -- --viewers 500 --mode poll          (how the apps worked before live push)
//   npm run loadtest -- --viewers 2000 --mode watch        (a streamed match: the watch page, half signed in)
//
// Run against a freshly seeded database (npm run db:seed): it starts a scheduled match.

import 'dotenv/config';
// Thousands of simulated people come from this one machine: send the trusted-caller token so
// the test measures the server, not its rate limits.
if (process.env.INTERNAL_API_TOKEN) {
  const plain = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => plain(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-Internal-Token': process.env.INTERNAL_API_TOKEN! } })) as typeof fetch;
}

import pg from 'pg';
import { prisma } from '../src/db/client';

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'http://localhost:4000/api/v1');
const VIEWERS = Number(arg('viewers', '500'));
const SECONDS = Number(arg('seconds', '45'));
const MODE = arg('mode', 'sse') as 'sse' | 'poll' | 'watch';
const SIGNED_IN = Number(arg('signed-in', '0.5'));
const STREAM_POLL_MS = 10_000;
const MATCH = arg('match', 'm_prem_grp_prem_5_1');
const BALL_EVERY_MS = Number(arg('ball-ms', '2000'));
const POLL_MS = Number(arg('poll-ms', '3000'));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const dbStats = async () => (await db.query<{ xact: string; fetched: string }>("select xact_commit + xact_rollback as xact, tup_fetched + tup_returned as fetched from pg_stat_database where datname = current_database()")).rows[0];

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Device-Id': 'loadtest-scorer' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);

async function main() {
  await db.connect();
  const { session } = await call<{ session: { token: string } }>('POST', '/auth/sign-in', undefined, { identifier: 'tunde@ovalcast.app', password: 'cricket123' });
  const token = session.token;
  const m = await prisma.match.findUniqueOrThrow({ where: { id: MATCH } });
  if (m.status !== 'scheduled') throw new Error(`${MATCH} is ${m.status}. Reseed first: npm run db:seed`);
  const xi = async (teamId: string) => (await prisma.registration.findMany({ where: { competitionId: m.competitionId!, teamId, status: 'active' }, select: { playerId: true }, take: 11 })).map((r) => r.playerId);
  const [home, away] = [await xi(m.homeTeamId), await xi(m.awayTeamId)];
  await call('POST', `/matches/${MATCH}/score-myself`, token);
  await call('POST', `/matches/${MATCH}/start`, token, { battingFirstTeamId: m.homeTeamId, playingXI: { [m.homeTeamId]: home, [m.awayTeamId]: away }, openers: [home[0], home[1]], openingBowlerId: away[10] });

  // Watch mode: the match is streamed, and half the viewers are signed in (spread over the demo accounts).
  let streamId = '';
  const viewerTokens: string[] = [];
  if (MODE === 'watch') {
    streamId = (await call<{ stream: { id: string } }>('POST', `/matches/${MATCH}/streams`, token, { source: 'encoder' })).stream.id;
    for (const who of ['ngozi', 'kunle', 'joseph', 'musa', 'sola', 'femi', 'kwame'])
      viewerTokens.push((await call<{ session: { token: string } }>('POST', '/auth/sign-in', undefined, { identifier: `${who}@ovalcast.app`, password: 'cricket123' })).session.token);
  }

  let seq = 0;
  const sentAt = new Map<string, number>();
  const ball = async () => {
    seq += 1;
    const over = Math.floor((seq - 1) / 6);
    const clientId = `load-${Date.now()}-${seq}`;
    sentAt.set(clientId, Date.now());
    const t = Date.now();
    await call('POST', `/matches/${MATCH}/balls`, token, { clientId, innings: 1, seq, kind: 'delivery', strikerId: home[0], nonStrikerId: home[1], bowlerId: away[10 - (over % 2)], bat: seq % 4 === 0 ? 1 : 0 });
    return Date.now() - t;
  };
  // A realistic scorecard: 40 balls in before anyone watches.
  for (let i = 0; i < 40; i++) await ball();

  const latencies: number[] = [];
  const delivery: number[] = [];
  const ballWrites: number[] = [];
  let requests = 0;
  let bytes = 0;
  let errors = 0;
  let connected = 0;
  let stop = false;
  const controllers: AbortController[] = [];

  const pollViewer = async () => {
    await new Promise((r) => setTimeout(r, Math.random() * POLL_MS));
    while (!stop) {
      const t = Date.now();
      try {
        // What the apps did: the match, then every ball, every 3 seconds.
        for (const p of [`/matches/${MATCH}`, `/matches/${MATCH}/balls`]) {
          const r = await fetch(BASE + p);
          bytes += (await r.arrayBuffer()).byteLength;
          requests += 1;
          if (!r.ok) errors += 1;
        }
        latencies.push(Date.now() - t);
      } catch {
        errors += 1;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };

  const sseViewer = async (n = 0) => {
    const ac = new AbortController();
    controllers.push(ac);
    try {
      const t = Date.now();
      if (MODE === 'watch') {
        // Opening the watch page: the stream, the pass price, the match and its balls, then the live feed.
        const auth: Record<string, string> = n % 100 < SIGNED_IN * 100 ? { Authorization: `Bearer ${viewerTokens[n % viewerTokens.length]}` } : {};
        for (const p of [`/streams/${streamId}`, `/matches/${MATCH}/pass-offer`, `/matches/${MATCH}`, `/matches/${MATCH}/balls`]) {
          const r = await fetch(BASE + p, { headers: auth, signal: ac.signal });
          bytes += (await r.arrayBuffer()).byteLength;
          requests += 1;
          if (!r.ok) errors += 1;
        }
        // The page checks the stream every 10 seconds.
        void (async () => {
          await new Promise((r) => setTimeout(r, Math.random() * STREAM_POLL_MS));
          while (!stop) {
            try {
              const r = await fetch(`${BASE}/streams/${streamId}`, { headers: auth });
              bytes += (await r.arrayBuffer()).byteLength;
              requests += 1;
              if (!r.ok) errors += 1;
            } catch {
              if (!stop) errors += 1;
            }
            await new Promise((r) => setTimeout(r, STREAM_POLL_MS));
          }
        })();
      }
      const r = await fetch(`${BASE}/matches/${MATCH}/live`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
      connected += 1;
      requests += 1;
      latencies.push(Date.now() - t);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const msg = JSON.parse(data.slice(6)) as { type: string; event?: { clientId: string } };
          const sent = msg.type === 'ball' && msg.event ? sentAt.get(msg.event.clientId) : undefined;
          if (sent) delivery.push(Date.now() - sent);
        }
      }
    } catch (e) {
      if (!stop) errors += 1;
      void e;
    }
  };

  const before = await dbStats();
  const started = Date.now();
  const viewers = Array.from({ length: VIEWERS }, (_, n) => (MODE === 'poll' ? pollViewer() : sseViewer(n)));
  // Let every viewer finish opening the page and connect.
  const ready = Date.now();
  while (MODE !== 'poll' && connected < VIEWERS && Date.now() - ready < 60_000) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 1500));
  const pageLoadSeconds = (Date.now() - ready) / 1000;
  // From here on, viewers are watching: what it costs to keep them up to date, without the page-load rush.
  const watching = await dbStats();
  const watchingFrom = Date.now();
  while (Date.now() - started < SECONDS * 1000) {
    ballWrites.push(await ball());
    await new Promise((r) => setTimeout(r, BALL_EVERY_MS));
  }
  stop = true;
  const after = await dbStats();
  controllers.forEach((c) => c.abort());
  await Promise.race([Promise.all(viewers), new Promise((r) => setTimeout(r, POLL_MS + 2000))]);
  const secs = (Date.now() - started) / 1000;

  const out = {
    mode: MODE,
    viewers: VIEWERS,
    ...(MODE === 'watch' ? { signedIn: `${Math.round(SIGNED_IN * 100)}%` } : {}),
    seconds: Math.round(secs),
    ballsDuringTest: ballWrites.length,
    httpRequestsPerSec: Math.round(requests / secs),
    mbSentToViewers: +(bytes / 1e6).toFixed(1),
    dbTransactionsPerSec: Math.round((Number(after.xact) - Number(before.xact)) / secs),
    dbTransactionsPerSecWhileWatching: Math.round((Number(after.xact) - Number(watching.xact)) / ((Date.now() - watchingFrom) / 1000)),
    dbTransactionsForPageLoads: Number(watching.xact) - Number(before.xact),
    secondsForEveryoneToOpenThePage: +pageLoadSeconds.toFixed(1),
    dbRowsReadPerSec: Math.round((Number(after.fetched) - Number(before.fetched)) / secs),
    scorerBallSaveMs: { p50: pct(ballWrites, 50), p95: pct(ballWrites, 95) },
    ...(MODE === 'poll'
      ? { viewerRefreshMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99) }, ballReachesViewerMs: `up to ${POLL_MS} plus the refresh time` }
      : { connectMs: { p50: pct(latencies, 50), p95: pct(latencies, 95) }, ballReachesViewerMs: { p50: pct(delivery, 50), p95: pct(delivery, 95), p99: pct(delivery, 99) }, deliveries: delivery.length }),
    errors,
  };
  console.log(JSON.stringify(out, null, 2));
  await db.end();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
