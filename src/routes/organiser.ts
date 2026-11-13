// For organisers who aren't technical: type teams and players in by name,
// and score a match yourself instead of finding a scorer first.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, toJson } from '~/db/client';
import { oneAtATime } from '~/lib/lock';
import { requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { isClubAdmin, isLeagueAdmin, toCompetition, toPlayer, toTeam } from '~/lib/repo';
import { registerPlayers } from '~/lib/registration';
import { applyStoppage, replay, type RainRule } from '@/engine';
import type { Match } from '@/api/types';
import { ballEventsFor, forgetSetups, getMatch, refreshFromEvents, saveMatch, setupFor } from '~/services/matches';
import { checkContact, createInvite } from '~/lib/invites';
import { comp, enter } from './competitions';

const TEAM_COLOURS = ['#008751', '#7A1F2B', '#1B3A6B', '#B4561B', '#5B2C83', '#0F6E7A', '#8A6D1D', '#22313F', '#C2185B', '#2E5E2A'];
const names = z.array(z.string().trim().min(2).max(60)).max(40);

const shortName = (name: string) => {
  const words = name.trim().split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w) && !/^(cricket|club|cc|fc|the|of)$/i.test(w));
  return (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? name).slice(0, 3)).toUpperCase().slice(0, 4) || 'XI';
};
const playerRow = (teamId: string, name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { id: newId('player'), teamId, name: name.trim(), shortName: rest.length ? `${first![0]}. ${rest[rest.length - 1]}` : first!, role: 'allRounder', battingHand: 'R' };
};

export async function organiserRoutes(app: FastifyInstance) {
  // A team typed in by name, entered straight away. The organiser runs it until a club admin takes it on.
  app.post<{ Params: { id: string } }>('/competitions/:id/teams', async (req) => {
    const user = requireUser(req);
    const b = z.object({ name: z.string().trim().min(2, 'Give the team a name').max(60), players: names.optional() }).parse(req.body);
    // With every other change to this league's clubs, one at a time.
    return oneAtATime(`league:${req.params.id}`, async () => {
      const c = await comp(req.params.id);
      if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only the competition’s admins can add teams');
      if (c.teamIds.length >= c.maxTeams) throw conflict(`The competition is full at ${c.maxTeams} teams. Raise the limit in its settings to add more.`);
      const inIt = await prisma.team.findMany({ where: { id: { in: c.teamIds } }, select: { name: true } });
      if (inIt.some((t) => t.name.toLowerCase() === b.name.toLowerCase())) throw conflict(`${b.name} is already in`);
      const org = await prisma.organisation.findUnique({ where: { id: c.orgId }, select: { city: true } });
      const id = newId('team');
      await prisma.$transaction([
        prisma.team.create({ data: { id, name: b.name, shortName: shortName(b.name), colors: toJson([TEAM_COLOURS[c.teamIds.length % TEAM_COLOURS.length], '#F7F8F1']), homeGround: '', city: org?.city ?? '', founded: new Date().getFullYear(), orgId: c.orgId, staff: toJson([]) } }),
        prisma.membership.create({ data: { id: newId('mem'), userId: user.id, clubId: id, role: 'clubAdmin' } }),
        prisma.player.createMany({ data: [...new Set(b.players ?? [])].map((n) => playerRow(id, n)) }),
        prisma.entry.create({ data: { id: newId('entry'), competitionId: c.id, teamId: id, kind: 'invite', status: 'accepted', respondedAt: new Date() } }),
      ]);
      await enter(c, id);
      // The admin typed these players in, so they're approved even where squads need approval.
      await prisma.registration.updateMany({ where: { competitionId: c.id, teamId: id }, data: { approved: true } });
      return toTeam((await prisma.team.findUniqueOrThrow({ where: { id } })));
    });
  });

  // Players by name, no accounts needed: the club's admin, or an admin of a league the club plays in.
  app.post<{ Params: { id: string } }>('/teams/:id/players', async (req) => {
    const user = requireUser(req);
    // Names alone, or players with an optional email or WhatsApp number: those also get an invitation
    // that links them to the squad record made here.
    const b = z.object({ names: names.optional(), players: z.array(z.object({ name: z.string().trim().min(2).max(60), contact: z.string().trim().max(120).optional() })).max(40).optional() }).parse(req.body);
    const wanted = [...(b.names ?? []).map((name) => ({ name, contact: undefined as string | undefined })), ...(b.players ?? [])];
    if (!wanted.length) throw badRequest('Type at least one name');
    for (const w of wanted) if (w.contact) { const ok = checkContact(w.contact.includes('@') ? 'email' : 'whatsapp', w.contact, user.country ?? undefined); if (!ok.ok) throw badRequest(`${w.name}: ${ok.reason}`); }
    const comps = await prisma.competition.findMany({ where: { teamIds: { array_contains: [req.params.id] }, status: { not: 'completed' } }, select: { id: true, orgId: true, playerRules: true } });
    if (!isClubAdmin(user, req.params.id) && !comps.some((c) => isLeagueAdmin(user, c.orgId))) throw forbidden('Only the club’s admin, or an admin of its league, can add players');
    const existing = new Set((await prisma.player.findMany({ where: { teamId: req.params.id, guest: false }, select: { name: true } })).map((p) => p.name.toLowerCase()));
    const seen = new Set<string>();
    const fresh = wanted.filter((w) => !existing.has(w.name.toLowerCase()) && !seen.has(w.name.toLowerCase()) && seen.add(w.name.toLowerCase()));
    const rows = fresh.map((w) => playerRow(req.params.id, w.name));
    if (!rows.length) throw badRequest('They’re all in the squad already');
    await prisma.player.createMany({ data: rows });
    forgetSetups();
    for (const row of comps) {
      const c = toCompetition(await prisma.competition.findUniqueOrThrow({ where: { id: row.id } }));
      await registerPlayers(c, req.params.id, rows.map((p) => p.id), { approved: !c.playerRules.squadApproval || isLeagueAdmin(user, c.orgId) });
    }
    // Invitations for those with a contact: emailed now, or ready to send on WhatsApp from the club page.
    for (const [i, w] of fresh.entries()) if (w.contact) await createInvite(req.params.id, { name: w.name, channel: w.contact.includes('@') ? 'email' : 'whatsapp', contact: w.contact, playerId: rows[i].id }, user.country ?? undefined);
    return (await prisma.player.findMany({ where: { id: { in: rows.map((r) => r.id) } } })).map(toPlayer);
  });

  // Rain, bad light or a late start: minutes lost become fewer overs, and a revised target for the chase.
  app.post<{ Params: { id: string } }>('/matches/:id/stoppages', async (req) => {
    const user = requireUser(req);
    const b = z.object({ minutesLost: z.number().int().min(1).max(600), reason: z.enum(['rain', 'badLight', 'lateStart', 'other']) }).parse(req.body);
    const m = await getMatch(req.params.id);
    const c = m.competitionId ? await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true, rainRule: true, conditions: true } }) : null;
    const allowed = m.officials.scorerUserId === user.id || (c ? isLeagueAdmin(user, c.orgId) : m.createdBy === user.id);
    if (!allowed) throw forbidden('Only the scorer or the organiser can record a stoppage');
    if (m.status === 'completed' || m.status === 'abandoned') throw conflict('This match has finished');
    const setup = await setupFor(m);
    const events = await ballEventsFor(m.id);
    const state = m.battingFirstTeamId && events.length ? replay(setup, events) : undefined;
    const rule = (c?.rainRule ?? 'arr') as RainRule;
    const r = applyStoppage({ oversPerInnings: setup.conditions.oversPerInnings, ballsPerOver: setup.conditions.ballsPerOver, rule, previous: m.reduced, minutesLost: b.minutesLost, reason: b.reason, state });
    m.reduced = { reason: b.reason, minutesLost: r.minutesLost, overs: r.overs, target: r.target, rule, noResult: r.noResult || undefined, text: r.text, at: new Date().toISOString() };
    if (r.noResult) {
      m.status = 'abandoned';
      m.result = { outcome: 'noResult', text: 'No result' };
      m.outcomeNote = r.text;
      await saveMatch(m);
    } else {
      await saveMatch(m);
      if (state) await refreshFromEvents(m);
    }
    return getMatch(m.id);
  });

  // The organiser, or either club's admin, takes the scoring instead of finding a scorer.
  app.post<{ Params: { id: string } }>('/matches/:id/score-myself', async (req) => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    const orgId = m.competitionId ? (await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } }))?.orgId : undefined;
    const allowed = orgId ? isLeagueAdmin(user, orgId) || isClubAdmin(user, m.homeTeamId) || isClubAdmin(user, m.awayTeamId) : m.createdBy === user.id;
    if (!allowed) throw forbidden('Only the organiser or either club’s admin can take the scoring');
    if (m.status === 'completed' || m.status === 'abandoned') throw conflict('This match has finished');
    if (m.officials.scorerUserId && m.officials.scorerUserId !== user.id && (await prisma.ballEvent.count({ where: { matchId: m.id } })) > 0) throw conflict(`${m.officials.scorerName} is already scoring. Ask them for a handover code.`);
    m.officials = { ...m.officials, scorerUserId: user.id, scorerName: user.name };
    await saveMatch(m);
    return m;
  });
}
