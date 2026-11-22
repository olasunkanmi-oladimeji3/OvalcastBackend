// Where audiences come from: each stream view with the viewer's country and region (from their
// profile), and which region a league is in. No IP address is stored.
import type { FastifyRequest } from 'fastify';
import { json, prisma } from '~/db/client';
import { sha256 } from '~/lib/crypto';
import { newId } from '~/lib/ids';

type RegionRow = { id: string; name: string; country: string; cities: string[] };
let regionsCache: { at: number; rows: RegionRow[] } | undefined;

/** Regions with their cities, kept for ten minutes (they change rarely). */
export async function regions(): Promise<RegionRow[]> {
  if (regionsCache && Date.now() - regionsCache.at < 600_000) return regionsCache.rows;
  const rows = (await prisma.region.findMany()).map((r) => ({ id: r.id, name: r.name, country: r.country, cities: json<string[]>(r.cities) ?? [] }));
  regionsCache = { at: Date.now(), rows };
  return rows;
}

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The region a city is in, or the whole country when no region lists the city. */
export function regionFor(all: RegionRow[], city?: string | null, country?: string | null): { id: string; name: string; country: string } | undefined {
  const r = all.find((x) => (!country || same(x.country, country)) && x.cities.some((c) => same(c, city)));
  if (r) return { id: r.id, name: r.name, country: r.country };
  return country ? { id: `country:${country}`, name: country, country } : undefined;
}

/** Records one person opening a stream; a repeat open by the same viewer within six hours counts once. */
export async function recordStreamView(req: FastifyRequest, stream: { id: string; matchId: string; competitionId: string | null }) {
  const user = req.user;
  const who = user?.id ?? (req.headers['x-device-id'] as string | undefined) ?? req.ip;
  const viewer = sha256(`view:${who}`).slice(0, 32);
  const recent = await prisma.streamView.findFirst({ where: { streamId: stream.id, viewer, at: { gte: new Date(Date.now() - 6 * 3_600_000) } }, select: { id: true } });
  if (recent) return false;
  const region = user ? regionFor(await regions(), user.city, user.country) : undefined;
  await prisma.streamView.create({ data: { id: newId('sv'), streamId: stream.id, matchId: stream.matchId, competitionId: stream.competitionId, viewer, country: user?.country ?? null, regionId: region?.id ?? null } });
  return true;
}
