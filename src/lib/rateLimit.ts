// Rate limits and throttling.
//
// Limits: how many times a person (or, signed out, an address) may do something in a window.
// Counted in this process, or in Redis when REDIS_URL is set so every process shares the count.
// Over a limit: 429 with Retry-After, and RateLimit-* headers on every limited reply.
//
// Throttling: when this process is overloaded (the event loop is lagging, or too many requests
// are in flight), it turns away new non-essential requests with 503 and Retry-After instead of
// slowing down for everyone. Scoring balls, payments coming back from Flutterwave and health
// checks always get through.
//
// Many people share one address on mobile networks (carrier-grade NAT), at a ground's Wi-Fi or
// behind the website's own server, so limits by address are generous; signed-in people are
// counted by account. The website's server sends INTERNAL_API_TOKEN and isn't limited at all.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type By = 'ip' | 'user' | 'userOrIp' | 'identifier';
interface Rule {
  /** Shown in logs and used in the counter's key. */
  name: string;
  limit: number;
  windowSec: number;
  by: By;
  /** Which requests it counts: method and route template, as registered. */
  applies: (method: string, route: string) => boolean;
  /** What the person is told when they hit it. */
  message: string;
}

const P = '/api/v1';
const is = (method: string, ...routes: string[]) => (m: string, r: string) => m === method && routes.some((x) => r === P + x);
const MIN = 60;
const HOUR = 3600;

/** Routes that must never be turned away: scoring, payment confirmations, health, the live feed (capped separately). */
const ESSENTIAL = new Set([`${P}/matches/:id/balls`, `${P}/matches/:id/balls/:eventId/void`, '/webhooks/flutterwave', `${P}/streams/:id/health`, '/health', '/health/ready', `${P}/matches/:id/live`]);

const RULES: Rule[] = [
  // ---- Signing in and codes. Codes are SMS and email that cost money, so they're limited hardest.
  { name: 'sign-in:account', by: 'identifier', limit: 10, windowSec: 15 * MIN, applies: is('POST', '/auth/sign-in'), message: 'Too many sign-in attempts for this account' },
  { name: 'sign-in:address', by: 'ip', limit: 60, windowSec: 10 * MIN, applies: is('POST', '/auth/sign-in'), message: 'Too many sign-in attempts from this network' },
  { name: 'sign-up:address', by: 'ip', limit: 20, windowSec: HOUR, applies: is('POST', '/auth/sign-up'), message: 'Too many new accounts from this network' },
  { name: 'codes:account', by: 'identifier', limit: 5, windowSec: HOUR, applies: is('POST', '/auth/code', '/auth/sign-up'), message: 'Too many codes sent to this number or email' },
  { name: 'codes:address', by: 'ip', limit: 30, windowSec: HOUR, applies: is('POST', '/auth/code', '/auth/sign-up', '/auth/reset-password'), message: 'Too many codes requested from this network' },
  { name: 'verify:account', by: 'identifier', limit: 10, windowSec: 15 * MIN, applies: is('POST', '/auth/verify', '/auth/reset-password'), message: 'Too many tries with codes for this account' },

  // ---- Things that reach other people or cost money to look up.
  { name: 'invites', by: 'user', limit: 100, windowSec: HOUR, applies: is('POST', '/teams/:id/invites', '/competitions/:id/invites', '/matches/:id/officials/invite', '/teams/:id/admins', '/organisations/:id/admins', '/entries/:id/remind'), message: 'Too many invitations sent' },
  { name: 'contacts', by: 'user', limit: 10, windowSec: HOUR, applies: is('POST', '/me/contacts'), message: 'Too many contact lookups' },
  { name: 'bank-lookups', by: 'user', limit: 20, windowSec: HOUR, applies: is('POST', '/payouts/resolve'), message: 'Too many bank account lookups' },
  { name: 'payments', by: 'user', limit: 30, windowSec: HOUR, applies: is('POST', '/entries/:id/pay', '/matches/:id/passes', '/me/subscription', '/me/wallet/top-ups', '/organisations/:id/viewer-credits', '/organisations/:id/withdrawals'), message: 'Too many payment attempts' },

  // ---- Posting.
  { name: 'stories', by: 'user', limit: 20, windowSec: HOUR, applies: is('POST', '/stories'), message: 'Too many stories posted' },
  { name: 'comments', by: 'user', limit: 60, windowSec: HOUR, applies: is('POST', '/stories/:id/comments'), message: 'Too many comments' },
  { name: 'likes', by: 'user', limit: 300, windowSec: HOUR, applies: is('PUT', '/stories/:id/like'), message: 'Too many likes' },
  { name: 'community', by: 'user', limit: 10, windowSec: 24 * HOUR, applies: is('POST', '/community'), message: 'Too many Looking for posts today' },
  { name: 'ratings', by: 'user', limit: 60, windowSec: HOUR, applies: is('POST', '/people/:id/ratings'), message: 'Too many ratings' },
  { name: 'uploads', by: 'user', limit: 40, windowSec: HOUR, applies: is('POST', '/stories/photos', '/teams/:id/logo', '/me/certificates', '/competitions/:id/rules', '/competitions/:id/images', '/organisations/:id/images'), message: 'Too many uploads' },

  // ---- Scoring: a ball every few seconds at most, but a phone back from no signal sends a whole backlog.
  { name: 'balls', by: 'user', limit: 600, windowSec: MIN, applies: is('POST', '/matches/:id/balls', '/matches/:id/balls/:eventId/void'), message: 'Balls are arriving faster than any match is played' },

  // ---- Everything else: generous, to catch scripts rather than people.
  { name: 'search', by: 'userOrIp', limit: 60, windowSec: MIN, applies: is('GET', '/search'), message: 'Too many searches' },
  { name: 'reads', by: 'userOrIp', limit: 600, windowSec: MIN, applies: (m, r) => m === 'GET' && r.startsWith(P) && !ESSENTIAL.has(r), message: 'Too many requests' },
  { name: 'writes', by: 'userOrIp', limit: 120, windowSec: MIN, applies: (m, r) => m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && r.startsWith(P) && !ESSENTIAL.has(r) && !r.startsWith(`${P}/partner`), message: 'Too many changes' },
];

/** Development and tests can raise every limit (RATE_LIMIT_SCALE=20); production runs at 1. */
// Read when used, not when this file loads: the bundle can load it before .env is read.
const scale = () => Math.max(1, Number(process.env.RATE_LIMIT_SCALE ?? 1));
const limitOf = (r: { limit: number }) => r.limit * scale();

// ------------------------------------------------------------------ counting

type Count = { count: number; resetAt: number };
const memory = new Map<string, Count>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
}, 30_000).unref();

function hitMemory(key: string, windowMs: number): Count {
  const now = Date.now();
  const c = memory.get(key);
  if (!c || c.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    memory.set(key, fresh);
    return fresh;
  }
  c.count += 1;
  return c;
}

// INCR and set the expiry in one step, so a window can't be left without one.
const LUA = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end return {c, redis.call('PTTL', KEYS[1])}";
type RedisLike = { eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown> };
let redis: RedisLike | undefined;
let redisDown = false;

/** Shares counts between processes through Redis when REDIS_URL is set. */
export async function startRateLimits(log: (msg: string) => void) {
  const url = process.env.REDIS_URL;
  if (!url) return;
  const { Redis } = await import('ioredis');
  const r = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  r.on('error', () => {
    if (!redisDown) log('Rate limits: Redis unreachable, counting in this process until it’s back');
    redisDown = true;
  });
  r.on('ready', () => (redisDown = false));
  redis = r;
}

/** Counts one hit against a key; the count and when the window ends. */
export async function hit(key: string, windowSec: number): Promise<Count> {
  const ms = windowSec * 1000;
  if (redis && !redisDown) {
    try {
      const [count, ttl] = (await redis.eval(LUA, 1, `rl:${key}`, ms)) as [number, number];
      return { count, resetAt: Date.now() + Math.max(0, ttl) };
    } catch {
      // Redis failed mid-request: count here rather than turn everyone away.
    }
  }
  return hitMemory(key, ms);
}

/** For other limits (the partner API's per-key limit): throws a 429 when over. */
export async function checkLimit(key: string, limit: number, windowSec: number, message: string) {
  const c = await hit(key, windowSec);
  if (c.count > limit * scale()) throw Object.assign(new Error(`${message}. Try again in ${retryText(c.resetAt)}.`), { statusCode: 429, retryAfter: secondsUntil(c.resetAt) });
  return c;
}

const secondsUntil = (t: number) => Math.max(1, Math.ceil((t - Date.now()) / 1000));
function retryText(t: number) {
  const s = secondsUntil(t);
  return s < 90 ? `${s} seconds` : s < 90 * 60 ? `${Math.round(s / 60)} minutes` : `${Math.round(s / 3600)} hours`;
}

// ------------------------------------------------------------------ who's asking

/** The phone number or email being signed in to, or sent a code: its own counter, whoever asks. */
function identifierOf(req: FastifyRequest) {
  const b = req.body as { identifier?: unknown; email?: unknown; phone?: unknown } | undefined;
  const v = b?.identifier ?? b?.email ?? b?.phone;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().toLowerCase();
  // A phone number however it's typed (+234 802-555 0199); an email exactly as given.
  return t.includes('@') ? t : t.replace(/[^\d+]/g, '');
}

function keyFor(rule: Rule, req: FastifyRequest): string | undefined {
  switch (rule.by) {
    case 'ip':
      return `ip:${req.ip}`;
    case 'user':
      return req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    case 'userOrIp':
      return req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    case 'identifier': {
      const id = identifierOf(req);
      return id ? `id:${id}` : undefined;
    }
  }
}

/** The website's own server, load tests and other trusted callers. */
export const isInternal = (req: FastifyRequest) => !!process.env.INTERNAL_API_TOKEN && req.headers['x-internal-token'] === process.env.INTERNAL_API_TOKEN;

// ------------------------------------------------------------------ throttling

const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
let inFlight = 0;
const maxInFlight = () => Number(process.env.MAX_IN_FLIGHT ?? 4000);
const maxLagMs = () => Number(process.env.MAX_EVENT_LOOP_LAG_MS ?? 250);
let shed = 0;
// Checked each second: the average delay over that second. Overloaded only after two slow seconds
// in a row, so one slow moment (building stats at start-up, a big replay) doesn't turn people away.
let lastLagMs = 0;
let slowSeconds = 0;
setInterval(() => {
  // The monitor samples every 20 ms, so an idle loop reads about 20; that part isn't lag.
  lastLagMs = Math.max(0, lag.mean / 1e6 - 20);
  slowSeconds = lastLagMs > maxLagMs() ? slowSeconds + 1 : 0;
  lag.reset();
}, 1000).unref();

/** Whether this process is too busy for new non-essential work. */
function overloaded() {
  return inFlight > maxInFlight() || slowSeconds >= 2;
}

export const throttleStats = () => ({ inFlight, lagMs: Math.round(lastLagMs), shed, memoryKeys: memory.size, scale: scale(), shared: !!redis && !redisDown });

// ------------------------------------------------------------------ the hooks

function tooMany(reply: FastifyReply, resetAt: number, message: string) {
  return reply
    .status(429)
    .header('Retry-After', String(secondsUntil(resetAt)))
    .send({ message: `${message}. Try again in ${retryText(resetAt)}.`, retryAfter: secondsUntil(resetAt) });
}

export async function rateLimits(app: FastifyInstance) {
  // Turned away before any work is done.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (ESSENTIAL.has(route) || isInternal(req)) return;
    if (overloaded()) {
      shed += 1;
      return reply.status(503).header('Retry-After', '5').send({ message: 'Ovalcast is very busy right now. Try again in a few seconds.', retryAfter: 5 });
    }
  });
  // Counted until the connection closes, which happens however the request ends (even abandoned).
  // Live feeds stay open all match and are capped separately, so they don't count.
  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url === `${P}/matches/:id/live`) return;
    inFlight += 1;
    reply.raw.once('close', () => (inFlight -= 1));
  });

  // After the body is read (some limits count by the phone or email in it) and the user is known.
  app.addHook('preHandler', async (req, reply) => {
    if (isInternal(req) || req.user?.staff) return;
    const route = req.routeOptions.url ?? '';
    // Every rule that applies is counted, and the tightest one decides the headers.
    let tightest: { limit: number; remaining: number; resetAt: number } | undefined;
    for (const rule of RULES) {
      if (!rule.applies(req.method, route)) continue;
      const key = keyFor(rule, req);
      if (!key) continue;
      const c = await hit(`${rule.name}:${key}`, rule.windowSec);
      const limit = limitOf(rule);
      if (c.count > limit) {
        req.log.warn({ rule: rule.name, key, count: c.count }, 'Rate limited');
        return tooMany(reply, c.resetAt, rule.message);
      }
      const remaining = limit - c.count;
      if (!tightest || remaining < tightest.remaining) tightest = { limit, remaining, resetAt: c.resetAt };
    }
    if (tightest) {
      reply.header('RateLimit-Limit', String(tightest.limit));
      reply.header('RateLimit-Remaining', String(tightest.remaining));
      reply.header('RateLimit-Reset', String(secondsUntil(tightest.resetAt)));
    }
  });
}

// ------------------------------------------------------------------ live feeds held open

/**
 * Live feeds stay open for a whole match, so they're capped by how many one person or address
 * holds at once rather than by how often they're opened. Per process; a viewer needs one or two.
 */
const feedsPerUser = () => 10 * scale();
const feedsPerAddress = () => 300 * scale();
const feeds = new Map<string, number>();

/** Takes a slot for a live feed: a release function, or the reason it's refused. */
export function openFeed(req: FastifyRequest): { release: () => void } | { refused: string } {
  if (isInternal(req)) return { release: () => {} };
  const keys = [`ip:${req.ip}`, ...(req.user ? [`u:${req.user.id}`] : [])];
  if (req.user && (feeds.get(`u:${req.user.id}`) ?? 0) >= feedsPerUser()) return { refused: 'You have too many live matches open. Close one and try again.' };
  if ((feeds.get(`ip:${req.ip}`) ?? 0) >= feedsPerAddress()) return { refused: 'Too many live matches are open from this network. Try again shortly.' };
  for (const k of keys) feeds.set(k, (feeds.get(k) ?? 0) + 1);
  let done = false;
  return {
    release: () => {
      if (done) return;
      done = true;
      for (const k of keys) {
        const n = (feeds.get(k) ?? 1) - 1;
        if (n > 0) feeds.set(k, n);
        else feeds.delete(k);
      }
    },
  };
}
