// The partner API, for organisations connecting their own website or app.
// Organisation plan only; keys are issued by Ovalcast (scripts/issue-api-key.ts),
// never self-serve. A key reads its own organisation's data and can never score.
//
//   Authorization: Bearer ovl_live_…   (or x-api-key)
//
// Terms forbid betting use; the live feed carries the same delay as the overlay.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { json, prisma, toJson } from '~/db/client';
import { checkLimit } from '~/lib/rateLimit';
import { urlProblem } from '~/lib/safeFetch';
import { sha256 } from '~/lib/crypto';
import { ApiError, badRequest, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { subscribe, trackFeed } from '~/lib/live';
import { randomBytes } from 'node:crypto';
import { PARTNER_EVENTS } from '~/services/partners';

declare module 'fastify' {
  interface FastifyRequest {
    partner?: { clientId: string; orgId: string; sandbox: boolean };
  }
}

// Per key, shared by every server process (through Redis when it's set).
const PER_MINUTE = 600;

async function authenticate(req: FastifyRequest) {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? (req.headers['x-api-key'] as string | undefined);
  if (!header?.startsWith('ovl_')) throw new ApiError(401, 'Send your API key as a Bearer token');
  const c = await prisma.apiClient.findUnique({ where: { keyHash: sha256(header) } });
  if (!c || c.revokedAt) throw new ApiError(401, 'This API key is not valid');
  const org = await prisma.organisation.findUnique({ where: { id: c.orgId }, select: { plan: true } });
  if (org?.plan !== 'organisation') throw forbidden('The API is part of the Organisation plan');
  await checkLimit(`partner:${c.id}`, PER_MINUTE, 60, `Slow down: ${PER_MINUTE} requests a minute per key`);
  const month = new Date().toISOString().slice(0, 7);
  await prisma.apiClient.update({ where: { id: c.id }, data: { lastUsedAt: new Date(), usageMonth: month, requestsThisMonth: c.usageMonth === month ? { increment: 1 } : 1 } });
  req.partner = { clientId: c.id, orgId: c.orgId, sandbox: c.sandbox };
}

export async function partnerRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => authenticate(req));

  /** Reads through the app's own API, so partners get exactly the same shapes. */
  const forward = async (path: string, reply: FastifyReply) => {
    const r = await app.inject({ method: 'GET', url: `/api/v1${path}` });
    return reply.status(r.statusCode).header('content-type', 'application/json').send(r.body);
  };
  const ownCompetition = async (req: FastifyRequest, id: string) => {
    const c = await prisma.competition.findUnique({ where: { id }, select: { orgId: true } });
    if (!c || c.orgId !== req.partner!.orgId) throw notFound('Competition');
  };
  const ownMatch = async (req: FastifyRequest, id: string) => {
    const m = await prisma.match.findUnique({ where: { id }, select: { competition: { select: { orgId: true } } } });
    if (!m || m.competition?.orgId !== req.partner!.orgId) throw notFound('Match');
  };

  app.get('/organisation', (req, reply) => forward(`/organisations/${req.partner!.orgId}`, reply));
  app.get('/competitions', (req, reply) => forward(`/competitions?orgId=${req.partner!.orgId}`, reply));
  app.get<{ Params: { id: string } }>('/competitions/:id', async (req, reply) => (await ownCompetition(req, req.params.id), forward(`/competitions/${req.params.id}`, reply)));
  app.get<{ Params: { id: string } }>('/competitions/:id/standings', async (req, reply) => (await ownCompetition(req, req.params.id), forward(`/competitions/${req.params.id}/standings`, reply)));
  app.get<{ Params: { id: string } }>('/competitions/:id/leaderboards', async (req, reply) => (await ownCompetition(req, req.params.id), forward(`/competitions/${req.params.id}/leaderboards`, reply)));
  app.get<{ Params: { id: string } }>('/competitions/:id/fixtures', async (req, reply) => (await ownCompetition(req, req.params.id), forward(`/matches?competitionId=${req.params.id}`, reply)));
  app.get<{ Params: { id: string } }>('/matches/:id', async (req, reply) => (await ownMatch(req, req.params.id), forward(`/matches/${req.params.id}`, reply)));
  app.get<{ Params: { id: string } }>('/matches/:id/balls', async (req, reply) => (await ownMatch(req, req.params.id), forward(`/matches/${req.params.id}/balls`, reply)));
  app.get<{ Params: { id: string } }>('/players/:id', async (req, reply) => {
    const p = await prisma.player.findUnique({ where: { id: req.params.id }, select: { team: { select: { orgId: true } } } });
    const registered = await prisma.registration.count({ where: { playerId: req.params.id, competition: { orgId: req.partner!.orgId } } });
    if (!p || (p.team.orgId !== req.partner!.orgId && !registered)) throw notFound('Player');
    return forward(`/players/${req.params.id}/career`, reply);
  });

  // The live feed: one server-sent event per ball, void or status change.
  app.get<{ Params: { id: string } }>('/matches/:id/live', async (req, reply) => {
    await ownMatch(req, req.params.id);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    trackFeed(reply.raw);
    reply.raw.write(': connected\n\n');
    const after = Number(req.headers['last-event-id'] ?? 0) || undefined;
    const off = subscribe(req.params.id, (frame) => reply.raw.write(frame), after, { named: true });
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
    });
    return reply;
  });

  // Webhook endpoints. The secret is returned once, to check signatures.
  app.get('/webhooks', async (req) => (await prisma.partnerWebhook.findMany({ where: { clientId: req.partner!.clientId } })).map((w) => ({ id: w.id, url: w.url, events: json<string[]>(w.events), active: w.active })));
  app.post('/webhooks', async (req) => {
    const b = z.object({ url: z.string().url(), events: z.array(z.enum(PARTNER_EVENTS)).min(1) }).parse(req.body);
    // Never an internal address: the server would be sending requests into its own network.
    const problem = await urlProblem(b.url);
    if (problem) throw badRequest(`Webhook address refused: ${problem}`);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const w = await prisma.partnerWebhook.create({ data: { id: newId('wh'), clientId: req.partner!.clientId, url: b.url, secret, events: toJson(b.events) } });
    return { id: w.id, url: w.url, events: b.events, active: true, secret };
  });
  app.delete<{ Params: { id: string } }>('/webhooks/:id', async (req, reply) => {
    const gone = await prisma.partnerWebhook.deleteMany({ where: { id: req.params.id, clientId: req.partner!.clientId } });
    if (!gone.count) throw notFound('Webhook');
    return reply.status(204).send();
  });
}

/** A new key: shown once to Ovalcast staff to pass on; only its hash is stored. */
export function newApiKey(sandbox: boolean) {
  const key = `ovl_${sandbox ? 'test' : 'live'}_${randomBytes(24).toString('base64url')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 13) };
}
