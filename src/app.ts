import Fastify, { LogController } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ZodError } from 'zod';
import { attachUser } from './lib/auth';
import { requestContext } from './lib/requestContext';
import { rateLimits, startRateLimits, throttleStats } from './lib/rateLimit';
import { startBus } from './lib/bus';
import { endFeeds } from './lib/live';
import { clearAllCaches } from './lib/cache';
import { cacheStats, responseCache } from './lib/responseCache';
import { forgetMatch } from './services/matches';
import { ApiError } from './lib/errors';
import { prisma } from './db/client';
import { storageRoot } from './lib/storage';
import { authRoutes } from './routes/auth';
import { competitionRoutes } from './routes/competitions';
import { financeRoutes, webhookRoutes } from './routes/finance';
import { billingRoutes } from './routes/billing';
import { featureRoutes } from './routes/features';
import { adminRoutes } from './routes/admin';
import { organiserRoutes } from './routes/organiser';
import { partnerRoutes } from './routes/partner';
import { matchRoutes } from './routes/matches';
import { peopleRoutes } from './routes/people';
import { publicRoutes } from './routes/public';
import { backofficeRoutes } from './routes/backoffice';
import { embedRoutes } from './routes/embeds';
import { storyRoutes } from './routes/stories';
import { teamRoutes } from './routes/teams';

/**
 * Which websites' browsers may call the API. Production: the website (WEB_URL) and any other
 * addresses in CORS_ORIGINS (comma-separated, e.g. the www domain). Elsewhere, any. The phone app
 * isn't a browser and isn't affected; the public live feed allows any site itself.
 */
export function corsOrigins(env = process.env): true | string[] {
  if (env.NODE_ENV !== 'production') return true;
  const list = [env.WEB_URL, ...(env.CORS_ORIGINS ?? '').split(',')].map((o) => o?.trim().replace(/\/$/, '')).filter((o): o is string => !!o);
  return [...new Set(list)];
}

/** A caller's request id when it's a sensible one (a load balancer's), otherwise a new one. */
const requestId = (header: unknown) => (typeof header === 'string' && /^[\w.-]{8,64}$/.test(header) ? header : randomUUID());

/** TRUST_PROXY: true, a number of hops, or a comma-separated list of proxy addresses. Off by default. */
function trustProxy(v?: string): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  // Trust this many proxies in front of the server, nearest first.
  if (/^\d+$/.test(v)) return (_address, hop) => hop < Number(v);
  return v.split(',').map((x) => x.trim());
}

export async function buildApp() {
  // No log line per request: at match-day traffic that's thousands of writes a second. Slow requests
  // and errors are still logged (below). LOG_REQUESTS=true brings every request back for debugging.
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Never write a secret to the logs: sign-in tokens, API keys, Flutterwave's hash, passwords, codes.
      redact: { paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["verif-hash"]', 'req.headers.cookie', '*.password', '*.newPassword', '*.token', '*.code', '*.secret', '*.streamKey'], censor: '[hidden]' },
    },
    logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== 'true', requestIdLogLabel: 'requestId' }),
    keepAliveTimeout: 72_000,
    // Every log line for a request carries its id, and the reply says it (X-Request-Id) for support.
    genReqId: (req) => requestId(req.headers['x-request-id']),
    // JSON bodies up to 1 MB; files go through multipart, which has its own 10 MB limit.
    bodyLimit: 1024 * 1024,
    // On shutdown, close every connection (live feeds stay open otherwise) once requests in progress finish.
    forceCloseConnections: 'idle',
    // Behind a load balancer or CDN, the visitor's address is in X-Forwarded-For. TRUST_PROXY=true
    // (or the number of proxies, or their addresses) makes req.ip that address, for rate limits.
    trustProxy: trustProxy(process.env.TRUST_PROXY),
  });
  const SLOW_MS = Number(process.env.SLOW_REQUEST_MS ?? 500);
  app.addHook('onResponse', async (req, reply) => {
    // Live feeds stay open for the whole match; they aren't slow.
    if (req.url.includes('/live')) return;
    if (reply.elapsedTime > SLOW_MS || reply.statusCode >= 500) req.log.warn({ method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'Slow or failed request');
  });
  // Safe defaults on every reply. The API answers JSON, so nothing it sends should be framed,
  // sniffed as another type, or leak the page it was called from.
  const production = process.env.NODE_ENV === 'production';
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (production) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
  // Browsers (the website) need every method the API uses; @fastify/cors only allows GET, HEAD and POST by default.
  await app.register(cors, { origin: corsOrigins(), methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'Idempotency-Key'], exposedHeaders: ['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'X-Request-Id'] });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  // Public files only (club logos). Certificates are never served from here.
  // The folders are made first: on a fresh server they don't exist until the first upload.
  await Promise.all(['logos', 'stories'].map((d) => mkdir(path.join(storageRoot, d), { recursive: true })));
  await app.register(fastifyStatic, { root: path.join(storageRoot, 'logos'), prefix: '/files/logos/' });
  // Story photos are public too.
  await app.register(fastifyStatic, { root: path.join(storageRoot, 'stories'), prefix: '/files/stories/', decorateReply: false });

  // The request's origin, for code deep in a call (where to send a payer back to).
  requestContext(app);
  app.addHook('onRequest', attachUser);
  // Limits per person and address, and turning work away when this process is overloaded.
  await startRateLimits((m) => app.log.warn(m));
  await rateLimits(app);
  // Live messages and cache notices reach every server process (through Redis when REDIS_URL is set).
  await startBus((m) => app.log.info(m));
  // Shared answers for public reads. Registered before compression so it stores plain JSON.
  // A change made through a match's address (taking over scoring, a decision, a stoppage) may not go
  // through saveMatch, so the held copy of that match is dropped too. Balls keep it current themselves.
  await responseCache(app, { onWrite: (url) => { const id = /\/matches\/([^/?]+)/.exec(url)?.[1]; if (id && !/\/balls(\/|$|\?)/.test(url)) forgetMatch(id); } });
  // Smaller responses for everything else: a full scorecard is a fifth of the size gzipped.
  await app.register(compress, { global: true, threshold: 1024, encodings: ['gzip', 'deflate'] });

  app.setErrorHandler((err, _req, reply) => {
    const retryAfter = (err as { retryAfter?: number }).retryAfter;
    if (retryAfter) reply.header('Retry-After', String(retryAfter));
    if (err instanceof ApiError) return reply.status(err.status).send({ message: err.message, ...(retryAfter ? { retryAfter } : {}) });
    if (err instanceof ZodError) return reply.status(400).send({ message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ message: (err as Error).message });
    _req.log.error(err);
    // The id lets support find this exact failure in the logs.
    return reply.status(500).send({ message: 'Something went wrong on our side. Try again.', requestId: _req.id });
  });

  // Shutting down: end the live feeds first, so closing doesn't wait for matches to finish.
  app.addHook('preClose', async () => endFeeds());

  // Liveness: the process is up. Cheap, for frequent checks.
  app.get('/health', async () => ({ ok: true, cache: cacheStats(), load: throttleStats() }));
  // Readiness: it can reach the database. Load balancers send traffic only when this is 200.
  app.get('/health/ready', async (_req, reply) => {
    try {
      await prisma.$queryRaw`select 1`;
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false, message: 'Can’t reach the database' });
    }
  });
  // The seed script empties the caches after it replaces the data. Never in production.
  if (process.env.NODE_ENV !== 'production') app.post('/health/flush', async () => (clearAllCaches(), { flushed: true }));
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(publicRoutes);
      await api.register(teamRoutes);
      await api.register(competitionRoutes);
      await api.register(matchRoutes);
      await api.register(peopleRoutes);
      await api.register(financeRoutes);
      await api.register(billingRoutes);
      await api.register(featureRoutes);
      await api.register(adminRoutes);
      await api.register(organiserRoutes);
      await api.register(storyRoutes);
      await api.register(backofficeRoutes);
      await api.register(embedRoutes);
    },
    { prefix: '/api/v1' },
  );
  // The partner API, for organisations' own websites and apps: API keys, not sign-in.
  await app.register(partnerRoutes, { prefix: '/partner/v1' });
  // Provider webhooks sit outside /api/v1 and its sign-in.
  await app.register(webhookRoutes);
  return app;
}
