// Running an organisation or club day to day: admins, branding, fixture
// changes, squads, player of the match, invite links, following, the season
// rollover, safeguarding and data rights. Plus Ovalcast's own staff console.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminMember, Competition, FixtureRequest, Organisation, SeasonProposal, Standings, User } from '@/api/types';
import type * as P from '~/generated/prisma/client';
import { json, prisma, toJson } from '~/db/client';
import { globalShares } from '~/lib/shares';
import { requireStaff, requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { logStaff } from '~/lib/staffLog';
import { embedSettingsOf } from './embeds';
import { isClubAdmin, isLeagueAdmin, loadUser, notify, toCompetition, toOrg, toPlayer, toRegistration, toTeam } from '~/lib/repo';
import { storage } from '~/lib/storage';
import { newApiKey } from '~/routes/partner';
import { matchesThisMonth, refundMatchPasses } from '~/services/billing';
import { allows, featureAccess, setFeatureAccess } from '~/services/access';
import { DECISION_KINDS, decisionEffect, decisionHasWinner, decisionSharesPoints, decisionText, decisionsFor, normaliseIdentifier, ageOn } from '@/engine';
import { getMatch, saveMatch } from '~/services/matches';

const isOwner = (u: User, orgId: string) => u.memberships.some((m) => m.orgId === orgId && m.role === 'owner');

const contactOf = (u: { email: string | null; phone: string | null }) => u.email ?? u.phone ?? undefined;

async function orgAdmins(orgId: string): Promise<AdminMember[]> {
  const rows = await prisma.membership.findMany({ where: { orgId, role: { in: ['owner', 'leagueAdmin'] } }, include: { user: true } });
  const byUser = new Map<string, AdminMember>();
  for (const r of rows) {
    const cur = byUser.get(r.userId);
    if (!cur || r.role === 'owner') byUser.set(r.userId, { userId: r.userId, name: r.user.name, role: r.role as AdminMember['role'], contact: contactOf(r.user) });
  }
  return [...byUser.values()].sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.name.localeCompare(b.name)));
}
async function clubAdmins(teamId: string): Promise<AdminMember[]> {
  const rows = await prisma.membership.findMany({ where: { clubId: teamId, role: 'clubAdmin' }, include: { user: true } });
  return rows.map((r) => ({ userId: r.userId, name: r.user.name, role: 'clubAdmin', contact: contactOf(r.user) }));
}
async function orgWithLinks(o: P.Organisation): Promise<Organisation> {
  const [comps, clubs] = await Promise.all([prisma.competition.findMany({ where: { orgId: o.id }, select: { id: true } }), prisma.team.findMany({ where: { orgId: o.id }, select: { id: true } })]);
  return toOrg(o, comps.map((c) => c.id), clubs.map((c) => c.id));
}
const toFixtureRequest = (r: P.FixtureRequest): FixtureRequest => ({ id: r.id, matchId: r.matchId, teamId: r.teamId, requestedByName: r.requestedByName, startsAt: r.startsAt?.toISOString(), venue: r.venue ?? undefined, note: r.note, status: r.status as FixtureRequest['status'], createdAt: r.createdAt.toISOString() });

/** League matches are run by the league's admins; friendlies by whoever set them up, or their scorer. */
async function canRun(user: User, m: { competitionId?: string; createdBy?: string; officials: { scorerUserId?: string } }) {
  if (m.competitionId) {
    const c = await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } });
    return !!c && isLeagueAdmin(user, c.orgId);
  }
  return m.createdBy === user.id || m.officials.scorerUserId === user.id;
}


const nextSeason = (s: string) => {
  const two = /^(\d{4})\/(\d{2})$/.exec(s);
  if (two) return `${Number(two[1]) + 1}/${String(Number(two[2]) + 1).padStart(2, '0')}`;
  return /^\d{4}$/.test(s) ? String(Number(s) + 1) : `${s} (next)`;
};

export async function adminRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ admins
  app.get<{ Params: { id: string } }>('/organisations/:id/admins', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can see its admins');
    return orgAdmins(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/organisations/:id/admins', async (req) => {
    const user = requireUser(req);
    const { identifier } = z.object({ identifier: z.string().trim().min(5) }).parse(req.body);
    if (!isOwner(user, req.params.id)) throw forbidden('Only the owner can add admins');
    const other = await prisma.user.findUnique({ where: identifier.includes('@') ? { email: normaliseIdentifier(identifier, user.country) } : { phone: normaliseIdentifier(identifier, user.country) } });
    if (!other) throw notFound('Ovalcast account with that phone or email. Ask them to sign up first');
    if (await prisma.membership.count({ where: { userId: other.id, orgId: req.params.id, role: { in: ['owner', 'leagueAdmin'] } } })) throw conflict(`${other.name} is already an admin`);
    await prisma.membership.create({ data: { id: newId('mem'), userId: other.id, orgId: req.params.id, role: 'leagueAdmin' } });
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: req.params.id } });
    await notify(other.id, { kind: 'entry', title: `You are now an admin of ${org.name}`, body: `${user.name} added you.`, link: { pathname: '/organisation/[id]', params: { id: org.id } } });
    return orgAdmins(req.params.id);
  });
  app.delete<{ Params: { id: string; userId: string } }>('/organisations/:id/admins/:userId', async (req) => {
    const user = requireUser(req);
    if (!isOwner(user, req.params.id)) throw forbidden('Only the owner can remove admins');
    if (await prisma.membership.count({ where: { userId: req.params.userId, orgId: req.params.id, role: 'owner' } })) throw conflict('The owner cannot be removed');
    await prisma.membership.deleteMany({ where: { userId: req.params.userId, orgId: req.params.id, role: 'leagueAdmin' } });
    return orgAdmins(req.params.id);
  });
  app.get<{ Params: { id: string } }>('/teams/:id/admins', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only the club’s admins can see its admins');
    return clubAdmins(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/teams/:id/admins', async (req) => {
    const user = requireUser(req);
    const { identifier } = z.object({ identifier: z.string().trim().min(5) }).parse(req.body);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can add admins');
    const other = await prisma.user.findUnique({ where: identifier.includes('@') ? { email: normaliseIdentifier(identifier, user.country) } : { phone: normaliseIdentifier(identifier, user.country) } });
    if (!other) throw notFound('Ovalcast account with that phone or email. Ask them to sign up first');
    if (await prisma.membership.count({ where: { userId: other.id, clubId: req.params.id, role: 'clubAdmin' } })) throw conflict(`${other.name} is already an admin`);
    await prisma.membership.create({ data: { id: newId('mem'), userId: other.id, clubId: req.params.id, role: 'clubAdmin' } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: req.params.id } });
    await notify(other.id, { kind: 'entry', title: `You are now an admin of ${team.name}`, body: `${user.name} added you.`, link: { pathname: '/team/[id]', params: { id: team.id } } });
    return clubAdmins(req.params.id);
  });
  app.delete<{ Params: { id: string; userId: string } }>('/teams/:id/admins/:userId', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can remove admins');
    if ((await clubAdmins(req.params.id)).length <= 1) throw conflict('A club needs at least one admin. Add the new admin first.');
    await prisma.membership.deleteMany({ where: { userId: req.params.userId, clubId: req.params.id, role: 'clubAdmin' } });
    return clubAdmins(req.params.id);
  });

  // ----------------------------------------------------------- branding
  app.patch<{ Params: { id: string } }>('/organisations/:id', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can edit it');
    const b = z.object({ about: z.string().max(600).optional(), sponsors: z.array(z.string().trim().min(1)).max(12).optional(), brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), executives: z.array(z.object({ name: z.string(), title: z.string() })).max(20).optional() }).parse(req.body);
    const o = await prisma.organisation.update({ where: { id: req.params.id }, data: { ...(b.about !== undefined ? { about: b.about } : {}), ...(b.sponsors ? { sponsors: toJson(b.sponsors) } : {}), ...(b.brandColor ? { brandColor: b.brandColor } : {}), ...(b.executives ? { executives: toJson(b.executives) } : {}) } });
    return orgWithLinks(o);
  });

  /** A logo or a cover picture, as a multipart image with a `kind` field. */
  async function readImage(req: FastifyRequest, prefix: string) {
    const file = await req.file();
    if (!file) throw badRequest('Attach the picture as a file named image');
    if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) throw badRequest('Use a PNG, JPEG or WebP picture');
    const kind = (file.fields.kind as { value?: string } | undefined)?.value === 'cover' ? 'cover' : 'logo';
    const key = `logos/${prefix}-${kind}-${Date.now().toString(36)}.${file.mimetype.split('/')[1].replace('jpeg', 'jpg')}`;
    await storage.put(key, await file.toBuffer(), file.mimetype);
    return { kind, url: storage.publicUrl(key) };
  }
  app.post<{ Params: { id: string } }>('/organisations/:id/images', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can change its pictures');
    const img = await readImage(req, `org-${req.params.id}`);
    return orgWithLinks(await prisma.organisation.update({ where: { id: req.params.id }, data: img.kind === 'cover' ? { coverUrl: img.url } : { logoUrl: img.url } }));
  });
  app.post<{ Params: { id: string } }>('/competitions/:id/images', async (req) => {
    const user = requireUser(req);
    const c = await prisma.competition.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound('Competition');
    if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only the league’s admins can change its pictures');
    const img = await readImage(req, `comp-${c.id}`);
    return toCompetition(await prisma.competition.update({ where: { id: c.id }, data: img.kind === 'cover' ? { coverUrl: img.url } : { logoUrl: img.url } }));
  });

  // ----------------------------------------------------------- fixtures
  app.patch<{ Params: { id: string } }>('/matches/:id', async (req) => {
    const user = requireUser(req);
    const b = z.object({ startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))).optional(), venue: z.string().trim().min(1).optional(), swapSides: z.boolean().optional() }).parse(req.body);
    const m = await getMatch(req.params.id);
    if (!m.competitionId || !(await canRun(user, m))) throw forbidden('Only a league admin can change fixtures');
    if (m.status !== 'scheduled' && m.status !== 'toss') throw conflict('This match has started');
    if (b.startsAt) m.startsAt = new Date(b.startsAt).toISOString();
    // A new date ends a postponement.
    if (b.startsAt && m.decision?.kind === 'postponed') m.decision = undefined;
    // The league decides who is at home: swap the sides, and the ground with them unless a ground was given.
    let swapped = false;
    if (b.swapSides) {
      if (!m.homeTeamId || !m.awayTeamId) throw conflict('Both teams need to be known first');
      if (m.toss) throw conflict('The toss is done: home and away can’t change now');
      const grounds = await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, homeGround: true } });
      const groundOf = (id: string) => grounds.find((g) => g.id === id)?.homeGround || undefined;
      const atOldHome = !b.venue && m.venue === groundOf(m.homeTeamId);
      [m.homeTeamId, m.awayTeamId] = [m.awayTeamId, m.homeTeamId];
      if (atOldHome && groundOf(m.homeTeamId)) m.venue = groundOf(m.homeTeamId)!;
      swapped = true;
    }
    if (b.venue) m.venue = b.venue;
    await saveMatch(m);
    const admins = await prisma.membership.findMany({ where: { clubId: { in: [m.homeTeamId, m.awayTeamId] }, role: 'clubAdmin' }, select: { userId: true } });
    const names = swapped ? await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, name: true } }) : [];
    const nameOf = (id: string) => names.find((t) => t.id === id)?.name ?? '';
    await notify([...admins.map((a) => a.userId), ...(m.officials.scorerUserId ? [m.officials.scorerUserId] : [])], {
      kind: 'match',
      title: swapped ? 'Home and away have changed' : 'A fixture has moved',
      body: swapped ? `${nameOf(m.homeTeamId)} are now at home to ${nameOf(m.awayTeamId)}, ${new Date(m.startsAt).toUTCString().slice(0, 22)} at ${m.venue}.` : `Now ${new Date(m.startsAt).toUTCString().slice(0, 22)} at ${m.venue}.`,
      link: { pathname: '/match/[id]', params: { id: m.id } },
    });
    return m;
  });
  // Every way a match ends without being played out (engine/decisions): postponed, cancelled, no result,
  // abandoned, walkover, neither side turning up, conceded, or awarded by the league.
  app.post<{ Params: { id: string } }>('/matches/:id/outcome', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({
        kind: z.enum(['postponed', 'cancelled', 'noResult', 'abandoned', 'walkover', 'doubleForfeit', 'conceded', 'awarded']),
        winnerTeamId: z.string().optional(),
        reason: z.enum(['weather', 'groundUnfit', 'noShow', 'notEnoughPlayers', 'lateArrival', 'refusedToPlay', 'ineligiblePlayer', 'misconduct', 'safety', 'other']).optional(),
        note: z.string().trim().max(280).default(''),
        penaltyPoints: z.number().int().min(0).max(10).optional(),
      })
      .parse(req.body);
    const m = await getMatch(req.params.id);
    if (!(await canRun(user, m))) throw forbidden(m.competitionId ? 'Only the competition’s admins can decide a match' : 'Only whoever set up this friendly can decide it');
    if (!decisionsFor(m.status).includes(b.kind)) throw conflict('That doesn’t fit the match as it stands');
    if (!b.note && b.kind !== 'postponed') throw badRequest('Add a line saying what happened');
    const c = m.competitionId ? await prisma.competition.findUnique({ where: { id: m.competitionId } }) : null;
    const comp = c ? toCompetition(c) : undefined;
    const sides = [m.homeTeamId, m.awayTeamId];
    const knockout = !!m.winnerTo || comp?.stages.find((st) => st.id === m.stageId)?.kind === 'knockout';
    if ((decisionHasWinner(b.kind) || (knockout && decisionSharesPoints(b.kind))) && (!b.winnerTeamId || !sides.includes(b.winnerTeamId))) throw badRequest(decisionHasWinner(b.kind) ? 'Pick the side that gets the win' : 'This is a knockout: pick the side that goes through');
    if (knockout && b.kind === 'doubleForfeit') throw conflict('A knockout needs someone to go through: award it to one side instead');
    const teams = new Map((await prisma.team.findMany({ where: { id: { in: sides } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const loserId = b.winnerTeamId ? sides.find((t) => t !== b.winnerTeamId) : undefined;
    const text = decisionText(b.kind, { winner: teams.get(b.winnerTeamId ?? ''), loser: teams.get(loserId ?? '') }, b.reason);
    m.decision = { ...b, decidedByName: user.name, at: new Date().toISOString(), previousResult: b.kind === 'awarded' ? m.result?.text : undefined };
    if (b.kind !== 'postponed') {
      const fx = decisionEffect(b.kind);
      m.status = fx.status;
      m.result = { text: knockout && decisionSharesPoints(b.kind) ? `${text}. ${teams.get(b.winnerTeamId!)} go through` : text, outcome: fx.outcome!, winnerTeamId: b.winnerTeamId };
      m.outcomeNote = b.note || undefined;
      m.locked = true;
    }
    await saveMatch(m);
    // Knockouts: the winner, or the side named to go through, takes the next slot.
    if (m.winnerTo && b.winnerTeamId && b.kind !== 'postponed') {
      const next = await getMatch(m.winnerTo.matchId);
      if (m.winnerTo.side === 'home') next.homeTeamId = b.winnerTeamId;
      else next.awayTeamId = b.winnerTeamId;
      await saveMatch(next);
    }
    if (c && b.penaltyPoints && loserId && (b.kind === 'walkover' || b.kind === 'conceded' || b.kind === 'awarded')) {
      await prisma.deduction.create({ data: { id: newId('ded'), competitionId: c.id, teamId: loserId, points: b.penaltyPoints, reason: b.kind === 'awarded' && b.reason === 'ineligiblePlayer' ? 'ineligiblePlayer' : 'forfeit', note: b.note || text, matchId: m.id, status: 'active', by: user.id, byName: user.name, at: new Date() } });
    }
    const admins = await prisma.membership.findMany({ where: { clubId: { in: sides }, role: 'clubAdmin' }, select: { userId: true } });
    const label = DECISION_KINDS.find((d) => d.kind === b.kind)!.label.toLowerCase();
    await notify([...new Set(admins.map((a) => a.userId))].filter((id) => id !== user.id), { kind: 'match', title: `${teams.get(m.homeTeamId)} v ${teams.get(m.awayTeamId)}: ${label}`, body: b.note || text, link: { pathname: '/match/[id]', params: { id: m.id } } });
    return m;
  });
  app.post<{ Params: { id: string } }>('/matches/:id/fixture-requests', async (req) => {
    const user = requireUser(req);
    const b = z.object({ teamId: z.string(), startsAt: z.string().optional(), venue: z.string().trim().optional(), note: z.string().trim().min(1, 'Say why you need the change') }).parse(req.body);
    const m = await getMatch(req.params.id);
    if ((b.teamId !== m.homeTeamId && b.teamId !== m.awayTeamId) || !isClubAdmin(user, b.teamId)) throw forbidden('Only an admin of one of the clubs can ask');
    const r = await prisma.fixtureRequest.create({ data: { id: newId('fxr'), matchId: m.id, teamId: b.teamId, requestedBy: user.id, requestedByName: user.name, startsAt: b.startsAt ? new Date(b.startsAt) : null, venue: b.venue || null, note: b.note, status: 'pending' } });
    const c = m.competitionId ? await prisma.competition.findUnique({ where: { id: m.competitionId } }) : null;
    if (c) {
      const admins = await prisma.membership.findMany({ where: { orgId: c.orgId, role: { in: ['owner', 'leagueAdmin'] } }, select: { userId: true } });
      await notify(admins.map((a) => a.userId), { kind: 'match', title: 'A club asks to move a fixture', body: b.note, link: { pathname: '/competition/[id]', params: { id: c.id } } });
    }
    return toFixtureRequest(r);
  });
  app.get<{ Params: { id: string } }>('/competitions/:id/fixture-requests', async (req) => {
    requireUser(req);
    const ids = (await prisma.match.findMany({ where: { competitionId: req.params.id }, select: { id: true } })).map((m) => m.id);
    return (await prisma.fixtureRequest.findMany({ where: { matchId: { in: ids } }, orderBy: { createdAt: 'desc' } })).map(toFixtureRequest);
  });
  app.post<{ Params: { id: string } }>('/fixture-requests/:id/respond', async (req) => {
    const user = requireUser(req);
    const { response } = z.object({ response: z.enum(['approve', 'decline']) }).parse(req.body);
    const r = await prisma.fixtureRequest.findUnique({ where: { id: req.params.id } });
    if (!r) throw notFound('Request');
    const m = await getMatch(r.matchId);
    if (!(await canRun(user, m))) throw forbidden('Only a league admin can decide');
    if (r.status !== 'pending') throw conflict('Already decided');
    if (response === 'approve') {
      if (m.status !== 'scheduled' && m.status !== 'toss') throw conflict('This match has started');
      if (r.startsAt) m.startsAt = r.startsAt.toISOString();
      if (r.venue) m.venue = r.venue;
      await saveMatch(m);
    }
    const saved = await prisma.fixtureRequest.update({ where: { id: r.id }, data: { status: response === 'approve' ? 'approved' : 'declined' } });
    await notify(r.requestedBy, { kind: 'match', title: response === 'approve' ? 'Fixture change approved' : 'Fixture change declined', body: r.note, link: { pathname: '/match/[id]', params: { id: m.id } } });
    return toFixtureRequest(saved);
  });

  // -------------------------------------------------------------- squads
  app.post<{ Params: { id: string; teamId: string } }>('/competitions/:id/squads/:teamId/approve', async (req) => {
    const user = requireUser(req);
    const { playerIds } = z.object({ playerIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    const c = await prisma.competition.findUnique({ where: { id: req.params.id } });
    if (!c || !isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can approve squads');
    const where = { competitionId: c.id, teamId: req.params.teamId, status: 'active', ...(playerIds ? { playerId: { in: playerIds } } : {}) };
    await prisma.registration.updateMany({ where, data: { approved: true } });
    const admins = await prisma.membership.findMany({ where: { clubId: req.params.teamId, role: 'clubAdmin' }, select: { userId: true } });
    await notify(admins.map((a) => a.userId), { kind: 'entry', title: `${c.name}: squad approved`, body: 'Your players can be picked for matches.' });
    return (await prisma.registration.findMany({ where })).map(toRegistration);
  });
  app.post<{ Params: { id: string } }>('/registrations/:id/reject', async (req) => {
    const user = requireUser(req);
    const r = await prisma.registration.findUnique({ where: { id: req.params.id }, include: { competition: true } });
    if (!r) throw notFound('Registration');
    if (!isLeagueAdmin(user, r.competition.orgId)) throw forbidden('Only a league admin can turn down a player');
    return toRegistration(await prisma.registration.update({ where: { id: r.id }, data: { status: 'ended', approved: false } }));
  });

  // --------------------------------------------------- player of the match
  app.post<{ Params: { id: string } }>('/matches/:id/player-of-match', async (req) => {
    const user = requireUser(req);
    const { playerId } = z.object({ playerId: z.string() }).parse(req.body);
    const m = await getMatch(req.params.id);
    if (!(await canRun(user, m))) throw forbidden('Only the organiser can confirm the player of the match');
    if (m.status !== 'completed') throw conflict('Confirm once the match has finished');
    if (![...(m.playingXI?.[m.homeTeamId] ?? []), ...(m.playingXI?.[m.awayTeamId] ?? [])].includes(playerId)) throw badRequest('That player was not in either XI');
    m.playerOfMatchId = playerId;
    await saveMatch(m);
    return m;
  });

  // ----------------------------------------------------------- invite links
  app.get<{ Params: { id: string } }>('/invites/:id', async (req) => {
    const inv = await prisma.playerInvite.findUnique({ where: { id: req.params.id }, include: { team: true } });
    if (!inv) throw notFound('Invitation');
    return { invite: { id: inv.id, teamId: inv.teamId, name: inv.name, channel: inv.channel, contact: inv.contact, status: inv.status, createdAt: inv.createdAt.toISOString() }, team: toTeam(inv.team) };
  });
  app.post<{ Params: { id: string } }>('/invites/:id/accept', async (req) => {
    const user = requireUser(req);
    const inv = await prisma.playerInvite.findUnique({ where: { id: req.params.id }, include: { team: true } });
    if (!inv) throw notFound('Invitation');
    if (inv.status !== 'pending') throw conflict(inv.status === 'joined' ? 'This invitation has already been used' : 'This invitation was cancelled');
    const result = await prisma.$transaction(async (tx) => {
      let player = user.playerId ? await tx.player.findUnique({ where: { id: user.playerId } }) : null;
      if (!player) {
        const parts = user.name.split(/\s+/);
        player = await tx.player.create({ data: { id: newId('player'), teamId: inv.teamId, name: user.name, shortName: parts.length > 1 ? `${parts[0][0]}. ${parts.at(-1)}` : user.name, role: 'allRounder', battingHand: 'R' } });
        await tx.user.update({ where: { id: user.id }, data: { playerId: player.id } });
      }
      if (!(await tx.membership.count({ where: { userId: user.id, clubId: inv.teamId, role: 'player' } }))) await tx.membership.create({ data: { id: newId('mem'), userId: user.id, clubId: inv.teamId, role: 'player' } });
      await tx.playerInvite.update({ where: { id: inv.id }, data: { status: 'joined' } });
      return player;
    });
    const admins = await prisma.membership.findMany({ where: { clubId: inv.teamId, role: 'clubAdmin' }, select: { userId: true } });
    await notify(admins.map((a) => a.userId), { kind: 'entry', title: `${user.name} joined ${inv.team.name}`, body: 'They accepted your invitation.', link: { pathname: '/team/[id]', params: { id: inv.teamId } } });
    return { team: toTeam(inv.team), player: toPlayer(result) };
  });

  // ------------------------------------------------------------ following
  const followSchema = z.object({ kind: z.enum(['team', 'player', 'competition']), id: z.string() });
  const keyOf = (k: 'team' | 'player' | 'competition') => (k === 'team' ? 'teamIds' : k === 'player' ? 'playerIds' : 'competitionIds');
  async function setFollow(user: User, kind: 'team' | 'player' | 'competition', id: string, on: boolean) {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { follows: true } });
    const f = { teamIds: [] as string[], playerIds: [] as string[], competitionIds: [] as string[], ...json<Record<string, string[]>>(row.follows) };
    const key = keyOf(kind);
    f[key] = on ? [...new Set([...f[key], id])] : f[key].filter((x) => x !== id);
    await prisma.user.update({ where: { id: user.id }, data: { follows: toJson(f) } });
    return (await loadUser(user.id))!;
  }
  app.post('/me/follows', async (req) => {
    const user = requireUser(req);
    const b = followSchema.parse(req.body);
    return setFollow(user, b.kind, b.id, true);
  });
  app.delete('/me/follows', async (req) => {
    const user = requireUser(req);
    const b = followSchema.parse(req.body);
    return setFollow(user, b.kind, b.id, false);
  });

  // ------------------------------------------------------------- seasons
  async function proposal(orgId: string, moves: number): Promise<SeasonProposal> {
    const tiered = (await prisma.competition.findMany({ where: { orgId, tier: { not: null } }, orderBy: { tier: 'asc' } })).map(toCompetition);
    if (!tiered.length) throw conflict('Give your divisions a level first (1 for the top)');
    const season = tiered[0].season;
    const divisions = tiered.filter((c) => c.season === season);
    const tables = await Promise.all(
      divisions.map(async (c) => {
        const st = (await app.inject({ method: 'GET', url: `/api/v1/competitions/${c.id}/standings` })).json<Standings>();
        return st.groups.flatMap((g) => g.rows).sort((a, b) => b.points - a.points || b.nrr - a.nrr).map((r) => r.teamId);
      }),
    );
    const unfinished = await Promise.all(divisions.map((c) => prisma.match.count({ where: { competitionId: c.id, status: { notIn: ['completed', 'abandoned'] } } })));
    return {
      orgId, fromSeason: season, toSeason: nextSeason(season), movesPerDivision: moves,
      divisions: divisions.map((c, i) => {
        const promoted = i > 0 ? tables[i].slice(0, moves) : [];
        const relegated = i < divisions.length - 1 ? tables[i].slice(-moves) : [];
        const comingDown = i > 0 ? tables[i - 1].slice(-moves) : [];
        const goingUp = i < divisions.length - 1 ? tables[i + 1].slice(0, moves) : [];
        return { competitionId: c.id, name: c.name, tier: c.tier!, teamIds: [...tables[i].filter((t) => !promoted.includes(t) && !relegated.includes(t)), ...comingDown, ...goingUp], promoted, relegated, unfinished: unfinished[i] > 0 };
      }),
    };
  }
  app.get<{ Params: { id: string } }>('/organisations/:id/season-proposal', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only league admins can plan the next season');
    const { moves } = z.object({ moves: z.coerce.number().int().min(0).max(4).default(1) }).parse(req.query);
    return proposal(req.params.id, moves);
  });
  app.post<{ Params: { id: string } }>('/organisations/:id/season-proposal', async (req): Promise<Competition[]> => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only league admins can start the next season');
    const b = z.object({ toSeason: z.string().min(2), fromSeason: z.string(), divisions: z.array(z.object({ competitionId: z.string(), name: z.string(), tier: z.number().int(), teamIds: z.array(z.string()), promoted: z.array(z.string()), relegated: z.array(z.string()) })) }).parse(req.body);
    const created: Competition[] = [];
    for (const d of b.divisions) {
      const old = toCompetition(await prisma.competition.findUniqueOrThrow({ where: { id: d.competitionId } }));
      if (old.orgId !== req.params.id) throw forbidden('That competition belongs to another organisation');
      const id = `${old.id.replace(/_\d{4}.*$/, '')}_${b.toSeason.replace(/\D/g, '')}`;
      if (await prisma.competition.findUnique({ where: { id } })) throw conflict(`${old.name} ${b.toSeason} already exists`);
      const stages = old.stages.map((st, si) => ({ ...st, id: `${id}_s${si}`, groups: st.groups.map((g, gi) => ({ ...g, id: `${id}_g${si}${gi}`, teamIds: si === 0 ? d.teamIds.filter((_, ti) => ti % st.groups.length === gi) : [] })) }));
      const row = await prisma.competition.create({
        data: {
          // The next edition of the same tournament.
          id, orgId: old.orgId, seriesId: old.seriesId ?? old.id, category: old.category ?? 'league', name: old.name, season: b.toSeason, division: old.division, format: old.format, ballType: old.ballType, conditions: toJson(old.conditions), points: toJson(old.points), tieBreakers: toJson(old.tieBreakers),
          stages: toJson(stages), teamIds: toJson(d.teamIds), status: 'entries', entryPolicy: old.entryPolicy, entryFee: old.entryFee, maxTeams: old.maxTeams, startsOn: new Date(new Date(old.startsOn).getTime() + 365 * 86_400_000), playerRules: toJson(old.playerRules), seasonRules: toJson(old.seasonRules), tier: d.tier, logoUrl: old.logoUrl ?? null, coverUrl: old.coverUrl ?? null,
        },
      });
      for (const teamId of d.teamIds) {
        await prisma.entry.create({ data: { id: newId('entry'), competitionId: id, teamId, kind: 'invite', status: 'accepted', respondedAt: new Date() } });
        const squad = await prisma.player.findMany({ where: { teamId, guest: false }, select: { id: true } });
        if (squad.length) await prisma.registration.createMany({ data: squad.map((p) => ({ id: newId('reg'), competitionId: id, playerId: p.id, teamId, primary: true, since: new Date(), status: 'active', approved: !old.playerRules.squadApproval })) });
      }
      created.push(toCompetition(row));
    }
    // Record the moves on the organisation's honours page.
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: req.params.id } });
    const moves = json<unknown[]>(org.seasonMoves);
    for (const d of b.divisions) {
      for (const t of d.promoted) moves.push({ season: b.fromSeason, teamId: t, kind: 'promoted', from: d.name, to: b.divisions.find((x) => x.tier === d.tier - 1)?.name ?? '', status: 'confirmed' });
      for (const t of d.relegated) moves.push({ season: b.fromSeason, teamId: t, kind: 'relegated', from: d.name, to: b.divisions.find((x) => x.tier === d.tier + 1)?.name ?? '', status: 'confirmed' });
    }
    await prisma.organisation.update({ where: { id: org.id }, data: { seasonMoves: toJson(moves) } });
    return created;
  });

  // ------------------------------------------ safeguarding and data rights
  app.patch<{ Params: { id: string } }>('/players/:id/guardian', async (req) => {
    const user = requireUser(req);
    const today = new Date().toISOString().slice(0, 10);
    const b = z
      .object({
        minor: z.boolean().optional(),
        guardianConsent: z.boolean().optional(),
        // Never shown publicly. Setting it decides "under 18" from it.
        dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2010-05-21').refine((d) => d > '1900-01-01' && d <= today, 'That date of birth isn’t possible').nullable().optional(),
      })
      .parse(req.body);
    const p = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound('Player');
    if (!isClubAdmin(user, p.teamId)) throw forbidden('Only the club admin can change this');
    const dob = b.dateOfBirth === undefined ? (p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : null) : b.dateOfBirth;
    const minor = b.dateOfBirth ? ageOn(b.dateOfBirth, today) < 18 : (b.minor ?? p.minor);
    const saved = await prisma.player.update({ where: { id: p.id }, data: { minor, guardianConsent: minor && (b.guardianConsent ?? p.guardianConsent), ...(b.dateOfBirth !== undefined ? { dateOfBirth: b.dateOfBirth ? new Date(`${b.dateOfBirth}T00:00:00Z`) : null } : {}) } });
    return { ...toPlayer(saved), dateOfBirth: dob ?? undefined };
  });
  app.get('/me/export', async (req) => {
    const user = requireUser(req);
    const [row, player, certs, notes, wallet, entries, passes, subs, claims] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, name: true, email: true, phone: true, city: true, country: true, settings: true, officiating: true, follows: true, createdAt: true } }),
      user.playerId ? prisma.player.findUnique({ where: { id: user.playerId } }) : null,
      prisma.certificate.findMany({ where: { userId: user.id }, select: { id: true, role: true, title: true, issuer: true, year: true, status: true, uploadedAt: true } }),
      prisma.notification.findMany({ where: { userId: user.id } }),
      prisma.wallet.findUnique({ where: { userId: user.id } }),
      prisma.walletEntry.findMany({ where: { userId: user.id } }),
      prisma.matchPass.findMany({ where: { userId: user.id } }),
      prisma.subscription.findMany({ where: { userId: user.id } }),
      prisma.playerClaim.findMany({ where: { userId: user.id } }),
    ]);
    return { exportedAt: new Date().toISOString(), account: row, memberships: user.memberships, player, certificates: certs, notifications: notes, wallet: { balance: wallet?.balance ?? 0, entries }, passes, subscriptions: subs, claims };
  });
  app.post('/me/delete', async (req) => {
    const user = requireUser(req);
    const deleteOn = new Date(Date.now() + 30 * 86_400_000);
    await prisma.user.update({ where: { id: user.id }, data: { deleteOn } });
    await notify(user.id, { kind: 'entry', title: 'Account deletion requested', body: `Your account and personal data are deleted on ${deleteOn.toISOString().slice(0, 10)}. Sign in before then and cancel to keep it. Match records stay, with your name removed.` });
    return { deleteOn: deleteOn.toISOString() };
  });

  // --------------------------------------------------- Ovalcast staff
  app.get('/staff/organisations', async (req) => {
    requireStaff(req);
    const orgs = await prisma.organisation.findMany({ orderBy: { name: 'asc' } });
    return Promise.all(
      orgs.map(async (o) => ({
        org: await orgWithLinks(o),
        admins: (await orgAdmins(o.id)).length,
        competitions: await prisma.competition.count({ where: { orgId: o.id } }),
        matchesThisMonth: await matchesThisMonth({ orgId: o.id }),
        embeds: embedSettingsOf(o).status,
        embedsRequestedAt: o.embedsRequestedAt?.toISOString(),
        apiKeys: await prisma.apiClient.count({ where: { orgId: o.id, revokedAt: null } }),
      })),
    );
  });
  app.put<{ Params: { id: string } }>('/staff/organisations/:id/plan', async (req) => {
    const staff = requireStaff(req);
    const { plan } = z.object({ plan: z.enum(['free', 'organisation']) }).parse(req.body);
    const o = await prisma.organisation.update({ where: { id: req.params.id }, data: { plan } });
    const admins = await orgAdmins(o.id);
    await notify(admins.map((a) => a.userId), { kind: 'payment', title: plan === 'organisation' ? `${o.name} is on the Organisation plan` : `${o.name} is back on the Free plan`, body: plan === 'organisation' ? 'Unlimited competitions, online entry fees, several admins and the API are on.' : 'Plan limits apply again.' });
    await logStaff(staff, 'setPlan', 'organisation', o.id, plan);
    return orgWithLinks(o);
  });
  app.get('/staff/certificates', async (req) => {
    requireStaff(req);
    const rows = await prisma.certificate.findMany({ where: { status: 'pending' }, include: { user: { select: { name: true } } }, orderBy: { uploadedAt: 'asc' } });
    return rows.map((c) => ({ certificate: { id: c.id, role: c.role, title: c.title, issuer: c.issuer, year: c.year, fileName: c.fileName, fileUrl: `/api/v1/certificates/${c.id}/file`, status: c.status, uploadedAt: c.uploadedAt.toISOString() }, userId: c.userId, userName: c.user.name }));
  });
  app.post<{ Params: { id: string } }>('/staff/certificates/:id/review', async (req) => {
    const staff = requireStaff(req);
    const { decision } = z.object({ decision: z.enum(['verified', 'rejected']) }).parse(req.body);
    const c = await prisma.certificate.update({ where: { id: req.params.id }, data: { status: decision }, include: { user: { select: { name: true } } } });
    await logStaff(staff, 'reviewCertificate', 'user', c.userId, `${c.title}: ${decision}`);
    await notify(c.userId, { kind: 'official', title: decision === 'verified' ? `${c.title} verified` : `${c.title} not accepted`, body: decision === 'verified' ? 'It now shows a tick in Find officials.' : 'Upload a clearer copy, or contact Ovalcast.' });
    return { certificate: { id: c.id, role: c.role, title: c.title, issuer: c.issuer, year: c.year, fileName: c.fileName, fileUrl: `/api/v1/certificates/${c.id}/file`, status: c.status, uploadedAt: c.uploadedAt.toISOString() }, userId: c.userId, userName: c.user.name };
  });
  app.post<{ Params: { id: string } }>('/staff/organisations/:id/api-clients', async (req) => {
    const staff = requireStaff(req);
    const { name, live } = z.object({ name: z.string().trim().min(2), live: z.boolean() }).parse(req.body);
    const o = await prisma.organisation.findUnique({ where: { id: req.params.id } });
    if (!o) throw notFound('Organisation');
    if (!(await allows('api', o.plan === 'organisation' ? 'organisation' : 'free'))) throw conflict(`${o.name} is not on a plan that includes the API`);
    const { key, hash, prefix } = newApiKey(!live);
    const c = await prisma.apiClient.create({ data: { id: newId('api'), orgId: o.id, name, keyHash: hash, keyPrefix: prefix, sandbox: !live } });
    await logStaff(staff, 'issueApiKey', 'organisation', o.id, `${name}, ${live ? 'live' : 'sandbox'}`);
    return { client: { id: c.id, name: c.name, keyPrefix: c.keyPrefix, sandbox: c.sandbox, createdAt: c.createdAt.toISOString(), requestsThisMonth: 0, webhooks: [] }, key };
  });
  // Which features need a paid plan. Public, so the app and website know what to show; only staff change it.
  app.get('/feature-access', async () => featureAccess());
  // Ovalcast's current shares, for the pricing pages: of paid streams after the payment fee, and of entry fees.
  app.get('/shares', async () => {
    const { platformShare, entryShare } = await globalShares();
    return { platformShare, entryShare };
  });
  app.put('/staff/feature-access', async (req) => {
    const staff = requireStaff(req);
    const level = z.enum(['free', 'pro', 'organisation']);
    const b = z.object({ requires: z.object({ proAnalysis: level, adFree: level, rulesDocument: level, sellPasses: level, entryFeeCollection: level, api: level, multiDivision: level }), limitsEnforced: z.boolean() }).parse(req.body);
    const saved = await setFeatureAccess(b, staff.name);
    await logStaff(staff, 'featureAccess', 'settings', undefined, Object.entries(b.requires).filter(([, v]) => v !== 'free').map(([k, v]) => `${k}: ${v}`).join(', ') || 'Everything free');
    return saved;
  });
  app.post<{ Params: { id: string } }>('/staff/matches/:id/refund-passes', async (req) => {
    const staff = requireStaff(req);
    const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
    const r = await refundMatchPasses(req.params.id, reason);
    await logStaff(staff, 'refund', 'match', req.params.id, `${reason}. ${r.refunded} passes`);
    return r;
  });
}

