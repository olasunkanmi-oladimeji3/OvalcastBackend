// Shared answers for public reads. When a thousand people open the same league table,
// the first request reads Postgres and the rest get that answer from memory, including
// requests that arrive while the first is still loading. Responses also carry
// Cache-Control and ETag headers so a CDN in front of the API can serve them too.
//
// Any change (a POST, PUT, PATCH or DELETE that succeeds) empties the cache on every
// server process before its reply is sent; a new ball only drops that match's entries.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { emit, on } from './bus';
import { TtlCache, registerCache } from './cache';

interface Rule {
  /** Seconds an answer is shared for. */
  ttl: number;
  /** The answer depends on who's asking: signed-out visitors share one copy, each signed-in person has their own. */
  byUser?: boolean;
}

const P = '/api/v1';
/** Routes whose answers can be shared, by route pattern. */
const RULES: Record<string, Rule> = {
  // Live: a few seconds, and dropped as soon as a ball is scored.
  [`${P}/matches`]: { ttl: 3 },
  [`${P}/matches/:id`]: { ttl: 3 },
  [`${P}/matches/:id/balls`]: { ttl: 3 },
  [`${P}/matches/:id/eligibility`]: { ttl: 10 },
  [`${P}/matches/:id/lineups`]: { ttl: 10 },
  // Tables and stats.
  [`${P}/competitions/:id/standings`]: { ttl: 10 },
  [`${P}/competitions/:id/leaderboards`]: { ttl: 10 },
  [`${P}/competitions/:id/deductions`]: { ttl: 30 },
  [`${P}/regions/:id/leaders`]: { ttl: 30 },
  [`${P}/players/:id/career`]: { ttl: 10, byUser: true },
  [`${P}/players/:id/milestones`]: { ttl: 30 },
  [`${P}/players/:id/shots`]: { ttl: 30 },
  // Directory pages: change rarely, and any change empties the cache anyway.
  [`${P}/competitions`]: { ttl: 30 },
  [`${P}/competitions/:id`]: { ttl: 30 },
  [`${P}/entries`]: { ttl: 30 },
  [`${P}/registrations`]: { ttl: 30 },
  [`${P}/transfers`]: { ttl: 30 },
  [`${P}/teams`]: { ttl: 30 },
  [`${P}/teams/:id`]: { ttl: 30 },
  [`${P}/teams/:id/players`]: { ttl: 30, byUser: true },
  [`${P}/organisations`]: { ttl: 30 },
  [`${P}/organisations/:id`]: { ttl: 30 },
  [`${P}/regions`]: { ttl: 300 },
  [`${P}/officials`]: { ttl: 30 },
  [`${P}/people/:id`]: { ttl: 30, byUser: true },
  [`${P}/search`]: { ttl: 30 },
  [`${P}/community`]: { ttl: 5 },
  [`${P}/streams`]: { ttl: 5, byUser: true },
  [`${P}/streams/:id`]: { ttl: 5, byUser: true },
  [`${P}/feature-access`]: { ttl: 30 },
  // Signed-in pages: each person's own copy, for when the app reopens or refocuses a screen.
  [`${P}/me`]: { ttl: 10, byUser: true },
  [`${P}/me/plan`]: { ttl: 30, byUser: true },
  [`${P}/me/wallet`]: { ttl: 10, byUser: true },
  [`${P}/me/earnings`]: { ttl: 30, byUser: true },
  // Notifications can arrive without a change through the API (a result, an hourly job): short.
  [`${P}/notifications`]: { ttl: 5, byUser: true },
  [`${P}/me/official-invites`]: { ttl: 10, byUser: true },
  [`${P}/matches/:id/pass-offer`]: { ttl: 30, byUser: true },
  [`${P}/organisations/:id/finance`]: { ttl: 10, byUser: true },
  [`${P}/organisations/:id/admins`]: { ttl: 30, byUser: true },
  [`${P}/competitions/:id/fixture-requests`]: { ttl: 10, byUser: true },
  [`${P}/teams/:id/admins`]: { ttl: 30, byUser: true },
  [`${P}/matches/:id/clips`]: { ttl: 10, byUser: true },
  // The feed: each viewer's likes and what they may delete are in it.
  [`${P}/stories`]: { ttl: 5, byUser: true },
  // Asked by the website before each embed is shown.
  [`${P}/embeds/access`]: { ttl: 30 },
  [`${P}/stories/:id/comments`]: { ttl: 5 },
};

interface Cached {
  body: string;
  type: string;
  etag: string;
  gz?: Buffer;
}

const store = registerCache(new TtlCache<Cached>(5000));
const inflight = new Map<string, Promise<Cached | undefined>>();
const loading = new WeakMap<FastifyRequest, { key: string; rule: Rule; done: (c: Cached | undefined) => void; gen: number; promise: Promise<Cached | undefined> }>();
let hits = 0;
let misses = 0;

export const cacheStats = () => ({ entries: store.size, hits, misses });

const headers = (reply: FastifyReply, rule: Rule, etag: string) => {
  reply.header('ETag', etag);
  // Browsers always check (an unchanged answer is a 304 with no body), so nobody sees an old
  // scorer or score. A CDN may hold it for `ttl` seconds, and serve a slightly stale copy while it
  // refreshes; that allowance goes in CDN-Cache-Control, which browsers ignore.
  reply.header('Cache-Control', rule.byUser ? 'private, no-cache' : `public, no-cache, s-maxage=${rule.ttl}`);
  if (!rule.byUser) reply.header('CDN-Cache-Control', `public, max-age=${rule.ttl}, stale-while-revalidate=${rule.ttl * 10}`);
  if (rule.byUser) reply.header('Vary', 'Authorization');
};

function sendHit(req: FastifyRequest, reply: FastifyReply, c: Cached, rule: Rule) {
  hits += 1;
  headers(reply, rule, c.etag);
  reply.header('X-Cache', 'HIT');
  if (req.headers['if-none-match'] === c.etag) return reply.code(304).send();
  reply.type(c.type);
  // Compressed once, then the same bytes for everyone.
  if (c.body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    c.gz ??= gzipSync(c.body);
    reply.header('Content-Encoding', 'gzip');
    reply.header('Vary', rule.byUser ? 'Authorization, Accept-Encoding' : 'Accept-Encoding');
    return reply.send(c.gz);
  }
  return reply.send(c.body);
}

const matchIdIn = (url: string) => /\/matches\/([^/?]+)/.exec(url)?.[1];

// Bumped by every clear. A read that started before a change finishes after it with the old
// answer: it's sent to whoever asked, but not kept, and nobody new waits on it.
let generation = 0;
const forMatch = (id: string) => (k: string) => k.includes(`/matches/${id}`) || k.startsWith(`${P}/matches?`) || k === `${P}/matches`;
on('responses:clear', () => {
  generation += 1;
  store.clear();
  inflight.clear();
});
on('responses:match', (id) => {
  generation += 1;
  store.deleteWhere(forMatch(id as string));
  for (const k of [...inflight.keys()]) if (forMatch(id as string)(k)) inflight.delete(k);
});

export async function responseCache(app: FastifyInstance, opts: { onWrite?: (url: string) => void } = {}) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'GET') return;
    const rule = RULES[req.routeOptions.url ?? ''];
    if (!rule) return;
    const key = rule.byUser && req.user ? `${req.user.id}|${req.url}` : req.url;
    const hit = store.get(key) ?? (await inflight.get(key));
    if (hit) return sendHit(req, reply, hit, rule);
    misses += 1;
    let done!: (c: Cached | undefined) => void;
    const promise = new Promise<Cached | undefined>((r) => (done = r));
    inflight.set(key, promise);
    loading.set(req, { key, rule, done, gen: generation, promise });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // A change: drop what it affects before the reply leaves, so the client's next read is fresh.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && reply.statusCode < 400) {
      const matchId = matchIdIn(req.url);
      // A ball changes one match; anything else may change any page.
      if (matchId && /\/balls(\/|$|\?)/.test(req.url)) emit('responses:match', matchId);
      else emit('responses:clear', null);
      opts.onWrite?.(req.url);
      return payload;
    }
    const l = loading.get(req);
    if (!l) return payload;
    loading.delete(req);
    if (inflight.get(l.key) === l.promise) inflight.delete(l.key);
    if (reply.statusCode !== 200 || typeof payload !== 'string') {
      l.done(undefined);
      return payload;
    }
    const c: Cached = { body: payload, type: String(reply.getHeader('content-type') ?? 'application/json; charset=utf-8'), etag: `W/"${createHash('sha1').update(payload).digest('base64url').slice(0, 20)}"` };
    if (l.gen === generation) store.set(l.key, c, l.rule.ttl * 1000);
    l.done(c);
    headers(reply, l.rule, c.etag);
    reply.header('X-Cache', 'MISS');
    return payload;
  });

  app.addHook('onResponse', async (req) => {
    // A failed load: anyone waiting on it reads for themselves.
    const l = loading.get(req);
    if (l) {
      loading.delete(req);
      if (inflight.get(l.key) === l.promise) inflight.delete(l.key);
      l.done(undefined);
    }
  });
}
