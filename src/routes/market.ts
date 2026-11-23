// A league's player marketplace, when the league turns it on (playerRules.market). Clubs in the league
// (and the league's admins and deputy approvers) see players open to offers, players their clubs
// list, and, if the league shows them, QYP players: those who may still add a second club here. A
// club makes an offer through the usual transfer steps (POST /transfers): the player agrees, their
// club releases, the league approves. Dates of birth never leave the server; only the QYP tag does.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { seasonOf } from '~/lib/seasons';
import { toRegistration } from '~/lib/repo';
import type { LeagueMarket, MarketListing, MarketPlayer, User } from '@/api/types';
import { isQyp, transferWindowNow } from '@/engine';
import { prisma } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { isClubAdmin, isLeagueAdmin, mayApprovePlayers } from '~/lib/repo';
import { comp } from './competitions';

type Row = { id: string; kind: string; wants: string; note: string | null; createdAt: Date };
const toListing = (r: Row): MarketListing => ({ id: r.id, kind: r.kind as MarketListing['kind'], wants: r.wants as MarketListing['wants'], ...(r.note ? { note: r.note } : {}), at: r.createdAt.toISOString() });

/** The player records that are this person: the one they signed up as, and any they claimed. */
async function myPlayerIds(user: User) {
  const claimed = await prisma.player.findMany({ where: { claimedByUserId: user.id }, select: { id: true } });
  return [...new Set([...(user.playerId ? [user.playerId] : []), ...claimed.map((p) => p.id)])];
}

export async function marketRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/competitions/:id/market', async (req): Promise<LeagueMarket> => {
    const user = requireUser(req);
    const c = await comp(req.params.id);
    const market = c.playerRules.market ?? { enabled: false, showQyp: false };
    const league = mayApprovePlayers(user, c.orgId);
    const myTeamIds = c.teamIds.filter((t) => isClubAdmin(user, t));
    const regs = await prisma.registration.findMany({ where: { competitionId: c.id, status: 'active' } });
    const mine = (await myPlayerIds(user)).filter((p) => regs.some((r) => r.playerId === p));
    const window = transferWindowNow(c);
    const base = { competitionId: c.id, enabled: market.enabled, showQyp: market.showQyp, windowOpen: window.open, windowNote: window.note, myTeamIds, myPlayerIds: mine };
    if (!league && !myTeamIds.length && !mine.length) throw forbidden('The marketplace is for the clubs and players in this league');
    if (!market.enabled && !league) return { ...base, players: [] };

    const listings = await prisma.marketListing.findMany({ where: { competitionId: c.id, status: 'active' }, orderBy: { createdAt: 'desc' } });
    const clubsOf = new Map<string, typeof regs>();
    for (const r of regs) clubsOf.set(r.playerId, [...(clubsOf.get(r.playerId) ?? []), r]);
    // Clubs see everyone on the market; a player who runs no club sees only themselves.
    const seesAll = league || myTeamIds.length > 0;
    let ids = new Set(listings.map((l) => l.playerId).filter((p) => clubsOf.has(p)));
    const players = await prisma.player.findMany({ where: { id: { in: [...clubsOf.keys()] } }, select: { id: true, name: true, role: true, dateOfBirth: true } });
    // QYP: players in the season's other leagues who may add this league as their second club
    // (the season allows QYP, they're within its age, with one club so far). The organisation approves each.
    const qyp = new Set<string>();
    const qypClub = new Map<string, string>();
    if (market.showQyp) {
      const season = await seasonOf(c.orgId, c.season);
      if (season.qyp.enabled) {
        const otherRegs = await prisma.registration.findMany({ where: { competitionId: { in: season.leagueIds.filter((l) => l !== c.id) }, status: 'active', playerId: { notIn: [...clubsOf.keys()] } } });
        const candidates = await prisma.player.findMany({ where: { id: { in: [...new Set(otherRegs.map((r) => r.playerId))] } }, select: { id: true, name: true, role: true, dateOfBirth: true } });
        const linked = await prisma.user.findMany({ where: { playerId: { in: candidates.filter((p) => !p.dateOfBirth).map((p) => p.id) } }, select: { playerId: true, dateOfBirth: true } });
        const born = new Map(linked.filter((u) => u.playerId && u.dateOfBirth).map((u) => [u.playerId!, u.dateOfBirth!]));
        const refs = otherRegs.map(toRegistration);
        for (const p of candidates) {
          const dob = p.dateOfBirth ?? born.get(p.id);
          if (isQyp(p.id, c.id, season, refs, dob?.toISOString().slice(0, 10))) {
            qyp.add(p.id);
            qypClub.set(p.id, refs.find((r) => r.playerId === p.id)!.teamId);
            players.push(p);
          }
        }
        ids = new Set([...ids, ...qyp]);
      }
    }
    if (!seesAll) ids = new Set([...ids].filter((p) => mine.includes(p)));
    const teams = new Map((await prisma.team.findMany({ where: { id: { in: [...c.teamIds, ...qypClub.values()] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const byId = new Map(players.map((p) => [p.id, p]));
    const out: MarketPlayer[] = [...ids].map((pid) => {
      const p = byId.get(pid)!;
      const here = clubsOf.get(pid);
      const main = here ? (here.find((r) => r.primary) ?? here[0]) : { teamId: qypClub.get(pid)! };
      const open = listings.find((l) => l.playerId === pid && l.kind === 'open');
      const listed = listings.find((l) => l.playerId === pid && l.kind === 'listed');
      return { playerId: pid, name: p.name, role: p.role, teamId: main.teamId, teamName: teams.get(main.teamId) ?? 'Their club', ...(open ? { open: toListing(open) } : {}), ...(listed ? { listed: toListing(listed) } : {}), qyp: qyp.has(pid) };
    });
    // Listed and open players first, newest first; then QYP players by name.
    const at = (m: MarketPlayer) => m.open?.at ?? m.listed?.at ?? '';
    out.sort((a, b) => at(b).localeCompare(at(a)) || a.name.localeCompare(b.name));
    return { ...base, players: out };
  });

  // The player marks themselves open to offers, or a club lists one of its players. Saying it again updates it.
  app.post<{ Params: { id: string } }>('/competitions/:id/market', async (req): Promise<MarketListing> => {
    const user = requireUser(req);
    const b = z.object({ playerId: z.string(), kind: z.enum(['open', 'listed']).optional(), wants: z.enum(['move', 'dual', 'either']).default('either'), note: z.string().trim().max(280).optional() }).parse(req.body);
    const c = await comp(req.params.id);
    if (!c.playerRules.market?.enabled) throw conflict(`${c.name} doesn’t have a marketplace. Its league admins can turn one on in the player rules`);
    const regs = await prisma.registration.findMany({ where: { competitionId: c.id, playerId: b.playerId, status: 'active' } });
    if (!regs.length) throw badRequest('That player isn’t in a squad in this league');
    const self = (await myPlayerIds(user)).includes(b.playerId);
    const club = regs.find((r) => isClubAdmin(user, r.teamId));
    const kind = b.kind ?? (self ? 'open' : 'listed');
    if (kind === 'open' && !self) throw forbidden('Only the player can say they’re open to offers');
    if (kind === 'listed' && !club) throw forbidden('Only their club can list a player');
    if (b.wants === 'dual') throw badRequest(`A player plays for one club in ${c.name}. A second club in another league this season is a QYP place, approved by the organisation`);
    const teamId = (kind === 'listed' ? club! : regs.find((r) => r.primary) ?? regs[0]).teamId;
    const existing = await prisma.marketListing.findFirst({ where: { competitionId: c.id, playerId: b.playerId, kind, status: 'active' } });
    const row = existing
      ? await prisma.marketListing.update({ where: { id: existing.id }, data: { wants: b.wants, note: b.note ?? null, teamId } })
      : await prisma.marketListing.create({ data: { id: newId('mkt'), competitionId: c.id, playerId: b.playerId, teamId, kind, wants: b.wants, note: b.note ?? null, createdBy: user.id } });
    return toListing(row);
  });

  // Taking a player off: the player (open), their club (listed), or a league admin.
  app.delete<{ Params: { id: string } }>('/market-listings/:id', async (req) => {
    const user = requireUser(req);
    const l = await prisma.marketListing.findUnique({ where: { id: req.params.id } });
    if (!l || l.status !== 'active') throw notFound('Listing');
    const c = await comp(l.competitionId);
    const allowed = isLeagueAdmin(user, c.orgId) || (l.kind === 'open' ? (await myPlayerIds(user)).includes(l.playerId) : isClubAdmin(user, l.teamId));
    if (!allowed) throw forbidden(l.kind === 'open' ? 'Only the player can take this down' : 'Only their club can take this down');
    await prisma.marketListing.update({ where: { id: l.id }, data: { status: 'closed' } });
    return { ok: true };
  });
}
