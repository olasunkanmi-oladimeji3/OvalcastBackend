// Clubs: squads, staff, logos, player invites, and careers.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Player, PlayerCareer, StaffMember, User } from '@/api/types';
import { json, prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { isClubAdmin, toPlayer, toTeam } from '~/lib/repo';
import { storage } from '~/lib/storage';
import { playerAliases } from '~/routes/features';
import { aggregate, mergeFigures, replayedMatches, type Figures } from '~/services/stats';

async function team(id: string) {
  const t = await prisma.team.findUnique({ where: { id } });
  if (!t) throw notFound('Team');
  return t;
}
const staffOf = (t: { staff: unknown }) => json<StaffMember[]>(t.staff as never);
const toInvite = (i: { createdAt: Date } & Record<string, unknown>) => ({ ...i, createdAt: i.createdAt.toISOString() });

const staffRoles = ['captain', 'viceCaptain', 'coach', 'manager', 'physio', 'scorer', 'analyst', 'kitManager'] as const;

/** Under-18s without a guardian's consent show as "Junior player" to everyone but their club's admins and themselves. */
const masked = (p: Player, viewer?: User): Player => (p.minor && !p.guardianConsent && !isClubAdmin(viewer, p.teamId) && viewer?.playerId !== p.id ? { ...p, name: 'Junior player', shortName: 'Junior' } : p);

export async function teamRoutes(app: FastifyInstance) {
  app.get('/teams', async (req) => {
    const { orgId } = z.object({ orgId: z.string().optional() }).parse(req.query);
    return (await prisma.team.findMany({ where: orgId ? { orgId } : {} })).map(toTeam);
  });

  app.get<{ Params: { id: string } }>('/teams/:id', async (req) => ({ ...toTeam(await team(req.params.id)), youtubeConnected: !!(await prisma.youTubeKey.findUnique({ where: { ownerId: req.params.id } })) }));

  // The club's own players, plus players registered with it as their second club in a league.
  app.get<{ Params: { id: string } }>('/teams/:id/players', async (req) => {
    // Practice sides pick from their club's squad.
    const parent = (await prisma.team.findUnique({ where: { id: req.params.id }, select: { parentTeamId: true } }))?.parentTeamId;
    const own = await prisma.player.findMany({ where: { teamId: { in: parent ? [req.params.id, parent] : [req.params.id] } } });
    const dual = await prisma.registration.findMany({ where: { teamId: req.params.id, status: 'active', primary: false }, select: { playerId: true } });
    const extra = dual.length ? await prisma.player.findMany({ where: { id: { in: dual.map((d) => d.playerId) } } }) : [];
    // Dates of birth only for the club's own admins (the reply is cached per person, so it doesn't leak).
    const admin = isClubAdmin(req.user, req.params.id);
    return [...own, ...extra.filter((p) => !own.some((o) => o.id === p.id))].map((p) => ({ ...masked(toPlayer(p), req.user), ...(admin && p.dateOfBirth ? { dateOfBirth: p.dateOfBirth.toISOString().slice(0, 10) } : {}) }));
  });

  app.post('/teams', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({ name: z.string().trim().min(1, 'A club needs a name'), shortName: z.string().trim().min(2).max(4), colors: z.tuple([z.string(), z.string()]), homeGround: z.string().trim().min(1, 'Add your home ground'), city: z.string().trim().min(1), founded: z.number().int().optional() })
      .parse(req.body);
    if (await prisma.team.findFirst({ where: { name: { equals: b.name, mode: 'insensitive' } } })) throw conflict('A club with that name already exists');
    const id = newId('team');
    const staff: StaffMember[] = [{ id: newId('staff'), name: user.name, role: 'manager', phone: user.phone, userId: user.id }];
    await prisma.$transaction([
      prisma.team.create({ data: { id, name: b.name, shortName: b.shortName.toUpperCase(), colors: toJson(b.colors), homeGround: b.homeGround, city: b.city, founded: b.founded ?? new Date().getFullYear(), staff: toJson(staff) } }),
      prisma.membership.create({ data: { id: newId('mem'), userId: user.id, clubId: id, role: 'clubAdmin' } }),
    ]);
    return toTeam(await team(id));
  });

  app.patch<{ Params: { id: string } }>('/teams/:id', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can edit the club');
    const b = z.object({ name: z.string().trim().min(1).optional(), shortName: z.string().trim().min(2).max(4).optional(), colors: z.tuple([z.string(), z.string()]).optional(), homeGround: z.string().trim().optional(), city: z.string().trim().optional() }).parse(req.body);
    await prisma.team.update({ where: { id: req.params.id }, data: { ...b, colors: b.colors ? toJson(b.colors) : undefined, ...(b.shortName ? { shortName: b.shortName.toUpperCase() } : {}) } });
    return toTeam(await team(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/teams/:id/logo', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can change the logo');
    const file = await req.file();
    if (!file) throw badRequest('Attach the logo as a file field named logo');
    if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) throw badRequest('Use a PNG, JPEG or WebP image');
    const ext = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    // Production: resize to 256px before storing.
    const key = `${req.params.id}-${Date.now().toString(36)}.${ext}`;
    await storage.put(`logos/${key}`, await file.toBuffer(), file.mimetype);
    await prisma.team.update({ where: { id: req.params.id }, data: { logoUrl: storage.publicUrl(`logos/${key}`) } });
    return toTeam(await team(req.params.id));
  });

  app.post<{ Params: { id: string } }>('/teams/:id/staff', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can add staff');
    const b = z.object({ name: z.string().trim().min(1, 'Add a name'), role: z.enum(staffRoles), phone: z.string().optional(), playerId: z.string().optional(), userId: z.string().optional() }).parse(req.body);
    const t = await team(req.params.id);
    // A club has one captain and one vice-captain.
    const kept = b.role === 'captain' || b.role === 'viceCaptain' ? staffOf(t).filter((s) => s.role !== b.role) : staffOf(t);
    await prisma.team.update({ where: { id: t.id }, data: { staff: toJson([...kept, { ...b, id: newId('staff') }]) } });
    return toTeam(await team(t.id));
  });

  app.delete<{ Params: { id: string; staffId: string } }>('/teams/:id/staff/:staffId', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can remove staff');
    const t = await team(req.params.id);
    await prisma.team.update({ where: { id: t.id }, data: { staff: toJson(staffOf(t).filter((s) => s.id !== req.params.staffId)) } });
    return toTeam(await team(t.id));
  });

  // ------------------------------------------------------------- player invites
  // Club admins only: an invite holds the person's phone or email, and its id is the link that joins the club.
  app.get<{ Params: { id: string } }>('/teams/:id/invites', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can see who has been invited');
    return (await prisma.playerInvite.findMany({ where: { teamId: req.params.id, status: 'pending' } })).map(toInvite);
  });
  app.post<{ Params: { id: string } }>('/teams/:id/invites', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only a club admin can invite players');
    const b = z.object({ name: z.string().trim().min(1), channel: z.enum(['whatsapp', 'sms', 'email']), contact: z.string().trim().min(3) }).parse(req.body);
    // Production: send the personal link through the chosen channel.
    return toInvite(await prisma.playerInvite.create({ data: { id: newId('pinv'), teamId: req.params.id, ...b, status: 'pending' } }));
  });
  app.post<{ Params: { id: string } }>('/invites/:id/cancel', async (req) => {
    const user = requireUser(req);
    const inv = await prisma.playerInvite.findUnique({ where: { id: req.params.id } });
    if (!inv) throw notFound('Invite');
    if (!isClubAdmin(user, inv.teamId)) throw forbidden('Only a club admin can cancel invites');
    return toInvite(await prisma.playerInvite.update({ where: { id: inv.id }, data: { status: 'cancelled' } }));
  });

  // ------------------------------------------------------------------- careers
  app.get<{ Params: { id: string } }>('/players/:id/career', async (req): Promise<PlayerCareer> => {
    const p = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound('Player');
    // Matches the player's user has claimed, recorded under a typed-in name, count too.
    const figs = aggregate(await replayedMatches());
    const f = mergeFigures((await playerAliases(p.id)).map((id) => figs.get(id)).filter((x): x is Figures => !!x));
    return {
      player: masked(toPlayer(p), req.user),
      matches: f?.matches ?? 0,
      batting: { innings: f?.innings ?? 0, runs: f?.runs ?? 0, balls: f?.balls ?? 0, notOuts: f?.notOuts ?? 0, high: f?.high ?? 0, fifties: f?.fifties ?? 0, hundreds: f?.hundreds ?? 0, fours: f?.fours ?? 0, sixes: f?.sixes ?? 0 },
      bowling: { balls: f?.ballsBowled ?? 0, runs: f?.runsConceded ?? 0, wickets: f?.wickets ?? 0, best: f?.best ? `${f.best.wickets}/${f.best.runs}` : '–' },
      fielding: { catches: f?.catches ?? 0, runOuts: f?.runOuts ?? 0, stumpings: f?.stumpings ?? 0 },
      recent: f?.recent ?? [],
    };
  });
}

