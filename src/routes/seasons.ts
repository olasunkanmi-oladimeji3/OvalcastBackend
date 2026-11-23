// An organisation's seasons: every one of its leagues with the same season label. The season holds the
// QYP rules (a second club, in another league of the season, for players within its age the
// organisation approves), the QYP requests to decide, and match-by-match allowances for a player whose
// main and QYP clubs meet.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrgSeasonView, SeasonQypRequest } from '@/api/types';
import { prisma } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { recheckSeasonHolds } from '~/lib/registration';
import { clubAdminIds, isLeagueAdmin, mayApprovePlayers, notify } from '~/lib/repo';
import { getMatch } from '~/services/matches';

const SEASON = z.string().trim().min(1).max(20);

async function seasonView(orgId: string, season: string): Promise<OrgSeasonView> {
  const [settings, leagues, pending] = await Promise.all([
    prisma.orgSeason.findUnique({ where: { orgId_season: { orgId, season } } }),
    prisma.competition.findMany({ where: { orgId, season }, select: { id: true, name: true, status: true, startsOn: true, teamIds: true }, orderBy: { startsOn: 'asc' } }),
    prisma.seasonQyp.count({ where: { orgId, season, status: 'pending' } }),
  ]);
  return {
    orgId,
    season,
    qyp: { enabled: settings?.qypEnabled ?? false, maxAge: settings?.qypMaxAge ?? 23 },
    leagues: leagues.map((l) => ({ id: l.id, name: l.name, status: l.status as OrgSeasonView['leagues'][number]['status'], startsOn: l.startsOn.toISOString(), clubs: (l.teamIds as string[]).length })),
    pendingQyp: pending,
  };
}

/** A person's name from their account or player record. */
async function nameOf(personId: string) {
  const u = await prisma.user.findUnique({ where: { id: personId }, select: { name: true } });
  if (u) return u.name;
  return (await prisma.player.findUnique({ where: { id: personId }, select: { name: true } }))?.name ?? 'A player';
}

export async function seasonRoutes(app: FastifyInstance) {
  // Every season the organisation has, newest first, with its leagues and QYP rules.
  app.get<{ Params: { id: string } }>('/organisations/:id/seasons', async (req): Promise<OrgSeasonView[]> => {
    const labels = (await prisma.competition.findMany({ where: { orgId: req.params.id }, select: { season: true }, distinct: ['season'] })).map((c) => c.season);
    const views = await Promise.all(labels.map((s) => seasonView(req.params.id, s)));
    return views.sort((a, b) => (b.leagues[0]?.startsOn ?? '').localeCompare(a.leagues[0]?.startsOn ?? ''));
  });

  // The season's QYP rules: on or off, and the age (on the season's first day). League admins only.
  app.put<{ Params: { id: string } }>('/organisations/:id/season', async (req): Promise<OrgSeasonView> => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can change its season rules');
    const b = z.object({ season: SEASON, qypEnabled: z.boolean(), qypMaxAge: z.number().int().min(10).max(40) }).parse(req.body);
    if (!(await prisma.competition.count({ where: { orgId: req.params.id, season: b.season } }))) throw notFound('Season');
    await prisma.orgSeason.upsert({ where: { orgId_season: { orgId: req.params.id, season: b.season } }, create: { orgId: req.params.id, season: b.season, qypEnabled: b.qypEnabled, qypMaxAge: b.qypMaxAge }, update: { qypEnabled: b.qypEnabled, qypMaxAge: b.qypMaxAge } });
    return seasonView(req.params.id, b.season);
  });

  // QYP requests and decisions for a season: who, their main club and their second club.
  app.get<{ Params: { id: string } }>('/organisations/:id/season/qyp', async (req): Promise<SeasonQypRequest[]> => {
    const user = requireUser(req);
    if (!mayApprovePlayers(user, req.params.id)) throw forbidden('Only the organisation’s admins can see QYP requests');
    const { season } = z.object({ season: SEASON }).parse(req.query);
    const rows = await prisma.seasonQyp.findMany({ where: { orgId: req.params.id, season }, orderBy: [{ status: 'desc' }, { createdAt: 'asc' }] });
    const teams = new Map((await prisma.team.findMany({ where: { id: { in: rows.flatMap((r) => [r.mainTeamId, r.qypTeamId]) } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    return Promise.all(rows.map(async (r) => ({ id: r.id, season: r.season, playerId: r.playerId, name: await nameOf(r.playerId), mainTeamId: r.mainTeamId, mainTeam: teams.get(r.mainTeamId) ?? 'Club', qypTeamId: r.qypTeamId, qypTeam: teams.get(r.qypTeamId) ?? 'Club', status: r.status as SeasonQypRequest['status'], at: r.createdAt.toISOString() })));
  });

  // Approve or decline a QYP player (optionally swapping which club is their main one). Held squad
  // places in the season are checked again at once; the player and both clubs are told.
  app.post<{ Params: { id: string } }>('/season-qyp/:id', async (req) => {
    const user = requireUser(req);
    const b = z.object({ decision: z.enum(['approve', 'decline']), swap: z.boolean().optional() }).parse(req.body);
    const r = await prisma.seasonQyp.findUnique({ where: { id: req.params.id } });
    if (!r) throw notFound('QYP request');
    if (!mayApprovePlayers(user, r.orgId)) throw forbidden('Only the organisation’s admins can decide QYP requests');
    const main = b.swap ? r.qypTeamId : r.mainTeamId;
    const second = b.swap ? r.mainTeamId : r.qypTeamId;
    await prisma.seasonQyp.update({ where: { id: r.id }, data: { status: b.decision === 'approve' ? 'approved' : 'declined', mainTeamId: main, qypTeamId: second, decidedBy: user.id, decidedAt: new Date() } });
    await recheckSeasonHolds(r.orgId, r.season, r.playerId);
    const [name, teams] = await Promise.all([nameOf(r.playerId), prisma.team.findMany({ where: { id: { in: [main, second] } }, select: { id: true, name: true } })]);
    const tn = (id: string) => teams.find((t) => t.id === id)?.name ?? 'their club';
    const body = b.decision === 'approve' ? `${name} can play for ${tn(second)} as a QYP player this season. Main club: ${tn(main)}.` : `${name}'s QYP request for ${tn(second)} was declined. They play for ${tn(main)} this season.`;
    const told = new Set([...(await clubAdminIds(main)), ...(await clubAdminIds(second)), ...((await prisma.user.findUnique({ where: { id: r.playerId }, select: { id: true } })) ? [r.playerId] : [])]);
    await notify([...told], { kind: 'entry', title: b.decision === 'approve' ? 'QYP approved' : 'QYP declined', body, link: { pathname: '/organisation/[id]', params: { id: r.orgId } } });
    return { ok: true as const };
  });

  // A player whose main and QYP clubs meet sits out unless the organisation allows this match, for one club.
  app.post<{ Params: { id: string } }>('/matches/:id/clash-allowances', async (req) => {
    const user = requireUser(req);
    const b = z.object({ playerId: z.string(), teamId: z.string() }).parse(req.body);
    const m = await getMatch(req.params.id);
    if (!m.competitionId) throw badRequest('Only league matches have season rules');
    const c = await prisma.competition.findUniqueOrThrow({ where: { id: m.competitionId }, select: { orgId: true } });
    if (!mayApprovePlayers(user, c.orgId)) throw forbidden('Only the organisation’s admins can allow a player in a match between their clubs');
    if (b.teamId !== m.homeTeamId && b.teamId !== m.awayTeamId) throw badRequest('Pick one of the two clubs in this match');
    await prisma.clashAllowance.upsert({ where: { matchId_playerId: { matchId: m.id, playerId: b.playerId } }, create: { id: newId('clash'), matchId: m.id, playerId: b.playerId, teamId: b.teamId, allowedBy: user.id, allowedByName: user.name }, update: { teamId: b.teamId, allowedBy: user.id, allowedByName: user.name, at: new Date() } });
    return { ok: true as const };
  });

  app.delete<{ Params: { id: string; playerId: string } }>('/matches/:id/clash-allowances/:playerId', async (req) => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    const c = m.competitionId ? await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } }) : null;
    if (!c || !mayApprovePlayers(user, c.orgId)) throw forbidden('Only the organisation’s admins can change this');
    await prisma.clashAllowance.deleteMany({ where: { matchId: m.id, playerId: req.params.playerId } });
    return { ok: true as const };
  });
}
