// Organisations, regions and regional leaders, search, community posts,
// notifications, streams and clips.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LeaderRow, PostKind, RegionalLeaders } from '@/api/types';
import type * as P from '~/generated/prisma/client';
import { json, prisma } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { toCompetition, toOrg, toPlayer, toTeam } from '~/lib/repo';
import { aggregate, replayedMatches, teamIdsInCities, type Figures } from '~/services/stats';
import { mayWatch } from '~/services/billing';
import { on } from '~/lib/bus';
import { TtlCache, registerCache } from '~/lib/cache';

/** Organisations with their competitions, clubs and YouTube status: three queries however many there are. */
async function orgsWithLinks(orgs: P.Organisation[]) {
  const ids = orgs.map((o) => o.id);
  const [comps, clubs, yts] = await Promise.all([
    prisma.competition.findMany({ where: { orgId: { in: ids } }, select: { id: true, orgId: true } }),
    prisma.team.findMany({ where: { orgId: { in: ids } }, select: { id: true, orgId: true } }),
    prisma.youTubeKey.findMany({ where: { ownerId: { in: ids } }, select: { ownerId: true } }),
  ]);
  return orgs.map((o) => ({
    ...toOrg(o, comps.filter((c) => c.orgId === o.id).map((c) => c.id), clubs.filter((c) => c.orgId === o.id).map((c) => c.id)),
    plan: o.plan as 'free' | 'organisation',
    youtubeConnected: yts.some((y) => y.ownerId === o.id),
  }));
}
const orgWithLinks = async (o: P.Organisation) => (await orgsWithLinks([o]))[0];

const toRegion = (r: P.Region) => ({ ...r, cities: json<string[]>(r.cities) });
const toPost = (p: P.Post) => ({ id: p.id, kind: p.kind as PostKind, regionId: p.regionId, title: p.title, body: p.body, authorName: p.authorName, teamId: p.teamId ?? undefined, whatsapp: p.whatsapp, when: p.when?.toISOString(), createdAt: p.createdAt.toISOString() });

const streams = registerCache(new TtlCache<P.Stream | null>(2000));
on('responses:clear', () => streams.clear());

export async function publicRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ organisations
  app.get('/organisations', async () => orgsWithLinks(await prisma.organisation.findMany()));
  app.get<{ Params: { id: string } }>('/organisations/:id', async (req) => {
    const o = await prisma.organisation.findUnique({ where: { id: req.params.id } });
    if (!o) throw notFound('Organisation');
    return orgWithLinks(o);
  });

  // ------------------------------------------------------------------ regions
  app.get('/regions', async () => (await prisma.region.findMany()).map(toRegion));
  app.get('/regions/nearest', async (req) => {
    const q = z.object({ lat: z.coerce.number(), lon: z.coerce.number() }).parse(req.query);
    const rad = (d: number) => (d * Math.PI) / 180;
    const dist = (r: { lat: number; lon: number }) => {
      const a = Math.sin(rad(r.lat - q.lat) / 2) ** 2 + Math.cos(rad(q.lat)) * Math.cos(rad(r.lat)) * Math.sin(rad(r.lon - q.lon) / 2) ** 2;
      return 2 * 6371 * Math.asin(Math.sqrt(a));
    };
    return (await prisma.region.findMany()).map(toRegion).sort((a, b) => dist(a) - dist(b))[0];
  });

  app.get<{ Params: { id: string } }>('/regions/:id/leaders', async (req) => {
    const r = await prisma.region.findUnique({ where: { id: req.params.id } });
    if (!r) throw notFound('Region');
    const region = toRegion(r);
    const teamIds = await teamIdsInCities(region.cities);
    const local = new Map((await prisma.player.findMany({ where: { teamId: { in: teamIds }, guest: false } })).map((p) => [p.id, p]));
    const replays = (await replayedMatches()).filter((x) => teamIds.includes(x.match.homeTeamId) || teamIds.includes(x.match.awayTeamId));
    const figs = [...aggregate(replays)].filter(([id]) => local.has(id));
    const top = (pick: (f: Figures) => number, detail: (f: Figures) => string, keep: (f: Figures, id: string) => boolean = () => true): LeaderRow[] =>
      figs
        .filter(([id, f]) => keep(f, id) && pick(f) > 0)
        .sort((a, b) => pick(b[1]) - pick(a[1]))
        .slice(0, 20)
        .map(([id, f]) => ({ playerId: id, teamId: local.get(id)!.teamId, value: Math.round(pick(f) * 10) / 10, detail: detail(f) }));
    const avg = (f: Figures) => (f.innings - f.notOuts > 0 ? (f.runs / (f.innings - f.notOuts)).toFixed(1) : '–');
    const role = (id: string) => local.get(id)!.role;
    const result: RegionalLeaders = {
      regionId: region.id,
      season: '2026/27',
      batters: top((f) => f.runs, (f) => `Average ${avg(f)}, strike rate ${f.balls ? ((f.runs / f.balls) * 100).toFixed(0) : 0}, high score ${f.high}`),
      bowlers: top((f) => f.wickets, (f) => `Economy ${f.ballsBowled ? ((f.runsConceded / f.ballsBowled) * 6).toFixed(2) : '–'}, average ${f.wickets ? (f.runsConceded / f.wickets).toFixed(1) : '–'}`, (f) => f.ballsBowled >= 12),
      keepers: top((f) => f.catches + f.stumpings, (f) => `${f.catches} catches, ${f.stumpings} stumpings`, (_f, id) => role(id) === 'keeper'),
      fielders: top((f) => f.catches + f.runOuts, (f) => `${f.catches} catches, ${f.runOuts} run outs`, (_f, id) => role(id) !== 'keeper'),
      allRounders: top((f) => f.runs + f.wickets * 20, (f) => `${f.runs} runs and ${f.wickets} wickets`, (f) => f.runs > 0 && f.wickets > 0),
    };
    return result;
  });

  // ------------------------------------------------------------------ search
  app.get('/search', async (req) => {
    const q = z.object({ q: z.string().default('') }).parse(req.query).q.trim();
    if (q.length < 2) return { players: [], teams: [], competitions: [] };
    const like = { contains: q, mode: 'insensitive' as const };
    const [ps, ts, cs] = await Promise.all([
      // Under-18s without a guardian's consent are private: they can't be found by name.
      prisma.player.findMany({ where: { name: like, guest: false, NOT: { minor: true, guardianConsent: false } }, take: 8 }),
      prisma.team.findMany({ where: { adHoc: false, OR: [{ name: like }, { shortName: { equals: q, mode: 'insensitive' } }, { city: like }] }, take: 8 }),
      prisma.competition.findMany({ where: { name: like }, take: 8 }),
    ]);
    return { players: ps.map(toPlayer), teams: ts.map(toTeam), competitions: cs.map(toCompetition) };
  });

  // --------------------------------------------------------------- community
  app.get('/community', async (req) => {
    const { regionId } = z.object({ regionId: z.string() }).parse(req.query);
    return (await prisma.post.findMany({ where: { regionId }, orderBy: { createdAt: 'desc' } })).map(toPost);
  });
  app.post('/community', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({ kind: z.enum(['clubWantsPlayers', 'playerWantsClub', 'friendlyWanted', 'needUmpire', 'needScorer', 'groundAvailable']), regionId: z.string(), title: z.string().trim().min(1, 'Add a short title').max(80), body: z.string().max(600).default(''), teamId: z.string().optional(), whatsapp: z.string(), when: z.string().optional() })
      .parse(req.body);
    const whatsapp = b.whatsapp.replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(whatsapp)) throw badRequest('Add a WhatsApp number with the country code, for example 234 802 555 0199');
    const p = await prisma.post.create({ data: { id: newId('post'), kind: b.kind, regionId: b.regionId, title: b.title, body: b.body, authorId: user.id, authorName: user.name, teamId: b.teamId ?? null, whatsapp, when: b.when ?? null } });
    return toPost(p);
  });

  // ----------------------------------------------------------- notifications
  app.get('/notifications', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { at: 'desc' }, take: 100 });
    return rows.map((n) => ({ id: n.id, userId: n.userId, kind: n.kind, title: n.title, body: n.body, at: n.at.toISOString(), read: n.read, link: json(n.link) ?? undefined }));
  });
  app.post('/notifications/read', async (req, reply) => {
    const user = requireUser(req);
    await prisma.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true } });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------- streams, clips
  // Paid streams: the playback URL and clips go only to the host and pass holders. The score stays free.
  const guard = async (s: P.Stream, userId?: string) => ((await mayWatch(userId, s.matchId)) ? s : { ...s, playbackUrl: '' });
  app.get('/streams', async (req) => {
    const { status } = z.object({ status: z.enum(['live', 'ended', 'scheduled']).optional() }).parse(req.query);
    return Promise.all((await prisma.stream.findMany({ where: status ? { status } : {} })).map((s) => guard(s, req.user?.id)));
  });
  app.get<{ Params: { id: string } }>('/streams/:id', async (req) => {
    // Every watcher checks the stream every few seconds: one read shared between them.
    const s = await streams.remember(req.params.id, 5_000, () => prisma.stream.findUnique({ where: { id: req.params.id } }));
    if (!s) throw notFound('Stream');
    return guard(s, req.user?.id);
  });
  app.get<{ Params: { id: string } }>('/matches/:id/clips', async (req) => ((await mayWatch(req.user?.id, req.params.id)) ? (await prisma.clip.findMany({ where: { matchId: req.params.id } })).reverse() : []));
}
