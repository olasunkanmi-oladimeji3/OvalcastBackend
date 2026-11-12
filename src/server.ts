import 'dotenv/config';
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { buildApp } from './app';
import { startDemoSimulator } from './services/demo';
import { startWebhookWorker } from './services/partners';
import { startJobs } from './services/jobs';
import { warmStats } from './services/stats';
import { checkConfig } from './lib/config';
import { prisma } from './db/client';

// Settings first: in production a missing essential stops the start with what to fix.
const config = checkConfig();
for (const w of config.warnings) console.warn(`[config] ${w}`);
if (config.errors.length) {
  console.error(`[config] The server can't start:\n${config.errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

// WEB_CONCURRENCY=<n> (or "auto", one per CPU core) runs n server processes sharing the port.
// Each holds its own live matches and caches, so it needs REDIS_URL to keep them in step.
const wanted = process.env.WEB_CONCURRENCY === 'auto' ? availableParallelism() : Number(process.env.WEB_CONCURRENCY ?? 1);
const workers = wanted > 1 && !process.env.REDIS_URL ? 1 : Math.max(1, wanted);

if (cluster.isPrimary && workers > 1) {
  for (let i = 0; i < workers; i++) cluster.fork({ OVALCAST_WORKER: String(i), OVALCAST_PROCESSES: String(workers) });
  // A process that dies is replaced; viewers it served reconnect and resume from their last message.
  const roles = new Map<number, string>();
  for (const id in cluster.workers) roles.set(cluster.workers[id]!.id, String(Number(id) - 1));
  let stopping = false;
  cluster.on('exit', (w, code) => {
    if (code === 0 || stopping) return;
    const role = roles.get(w.id) ?? '1';
    const next = cluster.fork({ OVALCAST_WORKER: role, OVALCAST_PROCESSES: String(workers) });
    roles.set(next.id, role);
  });
  // A redeploy: pass the stop on to every process, and exit once they've all finished.
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, () => {
      stopping = true;
      for (const id in cluster.workers) cluster.workers[id]?.process.kill('SIGTERM');
      setTimeout(() => process.exit(0), 25_000).unref();
      cluster.on('exit', () => Object.keys(cluster.workers ?? {}).length === 0 && process.exit(0));
    });
} else {
  const app = await buildApp();
  if (wanted > 1 && workers === 1) app.log.warn('WEB_CONCURRENCY needs REDIS_URL to keep processes in step: running one process');
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  // Player stats are built once at start-up, then kept up to date in the background.
  void warmStats().catch((e) => app.log.warn(e, 'Stats warm-up failed; they build on first use'));
  // Background work runs in one process only, and not at all when a separate worker does it
  // (BACKGROUND_WORK=off here, npm run worker there). A database lock stops two machines doubling up.
  const stops: (() => void)[] = [];
  if ((process.env.OVALCAST_WORKER ?? '0') === '0' && process.env.BACKGROUND_WORK !== 'off') {
    // Partner webhooks go out from a queue, retried with backoff.
    stops.push(startWebhookWorker());
    // Subscriptions, host payouts and account deletions, hourly.
    stops.push(startJobs(app.log));
    if (process.env.DEMO_SIMULATOR === 'true' && process.env.NODE_ENV !== 'production') startDemoSimulator(app.log);
  }

  // A redeploy or restart: stop taking requests, let those in progress finish (live feeds are closed;
  // viewers reconnect to the new server and resume from their last ball), then close the database.
  // A hard limit stops a stuck request holding the deploy up.
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      app.log.info(`${signal}: finishing requests in progress, then stopping`);
      setTimeout(() => process.exit(0), 20_000).unref();
      stops.forEach((stop) => stop());
      await app.close().catch((e) => app.log.error(e, 'Closing the server'));
      await prisma.$disconnect().catch(() => undefined);
      process.exit(0);
    });
}
