// Most watched: the leagues people watch most in each region, and the streamers they watch most.
// The public lists show views only; staff also see watch time, passes, what viewers paid and where
// audiences come from (by the viewer's own region, recorded from when that started).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MostWatched, StaffAudience } from '@/api/types';
import { prisma } from '~/db/client';
import { regionFor, regions } from '~/lib/audience';
import { requireStaff } from '~/lib/auth';

const DAYS = z.object({ days: z.coerce.number().int().refine((n) => [7, 30, 90, 365].includes(n), 'Pick 7, 30, 90 or 365 days').default(30) });

/** Streams of matches played in the period, with their league, organisation and streamer. */
async function watched(days: number) {
  const from = new Date(Date.now() - days * 86_400_000);
  const streams = await prisma.stream.findMany({
    where: { match: { startsAt: { gte: from, lte: new Date() } } },
    select: { id: true, views: true, liveSeconds: true, startedBy: true, streamer: true, matchId: true, match: { select: { competitionId: true } } },
  });
  const compIds = [...new Set(streams.map((s) => s.match.competitionId).filter((x): x is string => !!x))];
  const comps = await prisma.competition.findMany({ where: { id: { in: compIds } }, select: { id: true, name: true, season: true, orgId: true } });
  const orgs = await prisma.organisation.findMany({ where: { id: { in: [...new Set(comps.map((c) => c.orgId))] } }, select: { id: true, name: true, city: true, country: true, logoUrl: true } });
  const userIds = [...new Set(streams.map((s) => s.startedBy).filter((x): x is string => !!x))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, city: true, country: true } });
  return { from, streams, comps: new Map(comps.map((c) => [c.id, c])), orgs: new Map(orgs.map((o) => [o.id, o])), users: new Map(users.map((u) => [u.id, u])) };
}

type LeagueRow = MostWatched['regions'][number]['leagues'][number] & { liveMinutes: number; matchIds: Set<string> };
type StreamerRow = MostWatched['streamers'][number] & { liveMinutes: number; matchIds: Set<string> };

async function rank(days: number) {
  const w = await watched(days);
  const all = await regions();
  const leagues = new Map<string, LeagueRow>();
  const regionOfLeague = new Map<string, { id: string; name: string; country: string }>();
  const streamers = new Map<string, StreamerRow>();
  for (const s of w.streams) {
    const c = s.match.competitionId ? w.comps.get(s.match.competitionId) : undefined;
    const org = c ? w.orgs.get(c.orgId) : undefined;
    if (c && org) {
      const row = leagues.get(c.id) ?? { competitionId: c.id, name: c.name, season: c.season, orgId: org.id, orgName: org.name, ...(org.logoUrl ? { logoUrl: org.logoUrl } : {}), views: 0, streams: 0, liveMinutes: 0, matchIds: new Set<string>() };
      row.views += s.views;
      row.streams += 1;
      row.liveMinutes += Math.round(s.liveSeconds / 60);
      row.matchIds.add(s.matchId);
      leagues.set(c.id, row);
      const region = regionFor(all, org.city, org.country);
      if (region) regionOfLeague.set(c.id, region);
    }
    if (s.startedBy) {
      const u = w.users.get(s.startedBy);
      const row = streamers.get(s.startedBy) ?? { userId: s.startedBy, name: u?.name ?? s.streamer, ...(u?.city ? { city: u.city } : {}), views: 0, streams: 0, liveMinutes: 0, matchIds: new Set<string>() };
      row.views += s.views;
      row.streams += 1;
      row.liveMinutes += Math.round(s.liveSeconds / 60);
      row.matchIds.add(s.matchId);
      streamers.set(s.startedBy, row);
    }
  }
  // Leagues grouped by the region they're in, busiest region first.
  const byRegion = new Map<string, { id: string; name: string; country: string; views: number; leagues: LeagueRow[] }>();
  for (const l of leagues.values()) {
    if (!l.views) continue;
    const r = regionOfLeague.get(l.competitionId) ?? { id: 'unknown', name: 'Elsewhere', country: '' };
    const g = byRegion.get(r.id) ?? { ...r, views: 0, leagues: [] };
    g.views += l.views;
    g.leagues.push(l);
    byRegion.set(r.id, g);
  }
  const regionsOut = [...byRegion.values()].sort((a, b) => b.views - a.views).map((g) => ({ ...g, leagues: g.leagues.sort((a, b) => b.views - a.views) }));
  const streamersOut = [...streamers.values()].filter((s) => s.views > 0).sort((a, b) => b.views - a.views);
  return { w, regionsOut, streamersOut, leagues };
}

const publicLeague = ({ liveMinutes: _m, matchIds: _i, ...l }: LeagueRow) => l;
const publicStreamer = ({ liveMinutes: _m, matchIds: _i, ...s }: StreamerRow) => s;

export async function audienceRoutes(app: FastifyInstance) {
  // Public: top leagues in each region and top streamers, by views. No money.
  app.get('/insights/most-watched', async (req): Promise<MostWatched> => {
    const { days } = DAYS.parse(req.query);
    const r = await rank(days);
    return {
      days,
      regions: r.regionsOut.map((g) => ({ id: g.id, name: g.name, country: g.country, views: g.views, leagues: g.leagues.slice(0, 5).map(publicLeague) })),
      streamers: r.streamersOut.slice(0, 10).map(publicStreamer),
    };
  });

  // Staff: the same, with watch time, passes and what viewers paid, and where audiences come from.
  app.get('/staff/audience', async (req): Promise<StaffAudience> => {
    requireStaff(req);
    const { days } = DAYS.parse(req.query);
    const r = await rank(days);
    const matchIds = r.w.streams.map((s) => s.matchId);
    const passes = await prisma.matchPass.findMany({ where: { matchId: { in: matchIds }, status: { not: 'refunded' } }, select: { matchId: true, price: true, currency: true } });
    const paidFor = (ids: Set<string>) => {
      const ps = passes.filter((p) => p.matchId && ids.has(p.matchId));
      const gross: Record<string, number> = {};
      for (const p of ps) gross[p.currency] = (gross[p.currency] ?? 0) + p.price;
      return { passes: ps.length, paid: Object.entries(gross).map(([currency, amount]) => ({ currency, amount })) };
    };

    // Where viewers are: views recorded with the viewer's own region, and the leagues each region watches.
    const views = await prisma.streamView.findMany({ where: { at: { gte: r.w.from } }, select: { regionId: true, country: true, competitionId: true } });
    const all = await regions();
    const nameOf = (regionId: string | null, country: string | null) => (regionId?.startsWith('country:') ? regionId.slice(8) : all.find((x) => x.id === regionId)?.name) ?? country ?? 'Signed out or not set';
    const viewerRegions = new Map<string, { name: string; views: number; leagues: Map<string, number> }>();
    for (const v of views) {
      const key = v.regionId ?? v.country ?? 'unknown';
      const g = viewerRegions.get(key) ?? { name: nameOf(v.regionId, v.country), views: 0, leagues: new Map<string, number>() };
      g.views += 1;
      if (v.competitionId) g.leagues.set(v.competitionId, (g.leagues.get(v.competitionId) ?? 0) + 1);
      viewerRegions.set(key, g);
    }
    const leagueName = (id: string) => {
      const c = r.w.comps.get(id) ?? undefined;
      return c ? `${c.name} ${c.season}` : 'A league';
    };
    const compNames = new Map((await prisma.competition.findMany({ where: { id: { in: [...new Set(views.map((v) => v.competitionId).filter((x): x is string => !!x))] } }, select: { id: true, name: true, season: true } })).map((c) => [c.id, `${c.name} ${c.season}`]));

    return {
      days,
      recordedSince: (await prisma.streamView.findFirst({ orderBy: { at: 'asc' }, select: { at: true } }))?.at.toISOString(),
      regions: r.regionsOut.map((g) => ({ id: g.id, name: g.name, country: g.country, views: g.views, leagues: g.leagues.map((l) => ({ ...publicLeague(l), liveMinutes: l.liveMinutes, ...paidFor(l.matchIds) })) })),
      streamers: r.streamersOut.slice(0, 50).map((s) => ({ ...publicStreamer(s), liveMinutes: s.liveMinutes, ...paidFor(s.matchIds) })),
      viewerRegions: [...viewerRegions.entries()]
        .map(([id, g]) => ({ id, name: g.name, views: g.views, leagues: [...g.leagues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([competitionId, n]) => ({ competitionId, name: compNames.get(competitionId) ?? leagueName(competitionId), views: n })) }))
        .sort((a, b) => b.views - a.views),
    };
  });
}
