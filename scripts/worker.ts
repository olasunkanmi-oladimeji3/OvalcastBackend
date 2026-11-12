// The background worker: scheduled jobs (subscriptions ending, refunds for dropped streams, Monday
// payouts to streamers, account deletions) every hour, and partner webhooks every 10 seconds.
// For hosts that run background work as its own service: start this with `npm run worker` and set
// BACKGROUND_WORK=off on the API server. A database lock means two of them never double up.
//
//   npm run build && npm run worker

import 'dotenv/config';
import { prisma } from '~/db/client';
import { checkConfig } from '~/lib/config';
import { startJobs, runJobs } from '~/services/jobs';
import { startWebhookWorker } from '~/services/partners';

// One line of JSON per message, like the API server's logs.
const line = (level: 'info' | 'error') => (obj: unknown, msg?: string) => {
  const fields = typeof obj === 'string' ? { msg: obj } : obj instanceof Error ? { msg: msg ?? obj.message, err: obj.stack } : { ...(obj as object), msg };
  (level === 'error' ? console.error : console.log)(JSON.stringify({ level, time: Date.now(), service: 'worker', ...fields }));
};
const log = { info: line('info'), error: line('error') } as Parameters<typeof startJobs>[0];

const config = checkConfig();
for (const w of config.warnings) log.info(`[config] ${w}`);
if (config.errors.length) {
  log.error(`[config] The worker can't start: ${config.errors.join('; ')}`);
  process.exit(1);
}

const stopWebhooks = startWebhookWorker();
const stopJobs = startJobs(log);
// The first run straight away, not an hour after starting.
void runJobs(log).catch((e) => log.error(e));
log.info('Worker started: jobs hourly, partner webhooks every 10 seconds');

// On redeploy: stop taking new work, let the database connections close, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    log.info(`${signal}: stopping`);
    stopWebhooks();
    stopJobs();
    await prisma.$disconnect();
    process.exit(0);
  });
