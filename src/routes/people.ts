// People: public profiles, officiating and coaching details, certificates, and
// the officials directory.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Match, OfficiatingProfile, OfficialRole, PersonProfile, RatingSummary, StaffMember, User } from '@/api/types';
import { RATED_LABEL, RATING_ASPECTS, ratingAverage, ratingProblem } from '@/engine';
import type * as P from '~/generated/prisma/client';
import { json, Prisma, prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { isClubAdmin, isLeagueAdmin, loadUser, matchIdsWithOfficial, notify, toMatch } from '~/lib/repo';
import { storage } from '~/lib/storage';
import { aggregate, replayedMatches } from '~/services/stats';

const ROLES = ['scorer', 'umpire', 'groundsman', 'coach'] as const;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Officiating = Omit<OfficiatingProfile, 'certificates'>;
const emptyOfficiating: Officiating = { roles: [], available: false, days: [], travelKm: 20, bio: '', grounds: [] };
const officiatingOf = (u: P.User): Officiating => ({ ...emptyOfficiating, ...json<Officiating | null>(u.officiating) });
const ACTIVE = ['completed', 'live', 'inningsBreak'];

const RATED = ['player', 'scorer', 'umpire', 'groundsman', 'coach'] as const;
type Rated = (typeof RATED)[number];

/** Everyone already appointed (scorer, umpire, groundsman) to a match starting on this date (UTC). */
async function bookedOn(date: string) {
  const from = new Date(`${date}T00:00:00Z`);
  const to = new Date(from.getTime() + 86_400_000);
  const matches = await prisma.match.findMany({ where: { startsAt: { gte: from, lt: to }, status: { notIn: ['abandoned', 'cancelled'] } }, select: { officials: true } });
  const ids = new Set<string>();
  for (const m of matches) {
    const o = json<{ scorerUserId?: string; umpireUserIds?: string[]; groundsmanUserIds?: string[] }>(m.officials);
    for (const id of [o.scorerUserId, ...(o.umpireUserIds ?? []), ...(o.groundsmanUserIds ?? [])]) if (id) ids.add(id);
  }
  return ids;
}

/** "LEK v APA, 14 Oct", for rating lists. */
async function matchLabels(ms: { id: string; homeTeamId: string; awayTeamId: string; startsAt: string | Date }[]) {
  const names = new Map((await prisma.team.findMany({ where: { id: { in: ms.flatMap((m) => [m.homeTeamId, m.awayTeamId]) } }, select: { id: true, shortName: true } })).map((t) => [t.id, t.shortName]));
  return new Map(ms.map((m) => [m.id, `${names.get(m.homeTeamId) ?? 'Home'} v ${names.get(m.awayTeamId) ?? 'Away'}, ${new Date(m.startsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`]));
}

/** Average per aspect and overall, per path, with the latest few and the match each was for. */
async function ratingSummaries(userId: string): Promise<RatingSummary[]> {
  const rows = await prisma.rating.findMany({ where: { userId }, orderBy: { at: 'desc' } });
  const rated = [...new Set(rows.slice(0, 50).map((r) => r.matchId).filter((x): x is string => !!x))];
  const labels = rated.length ? await matchLabels(await prisma.match.findMany({ where: { id: { in: rated } }, select: { id: true, homeTeamId: true, awayTeamId: true, startsAt: true } })) : new Map<string, string>();
  return RATED.flatMap((role) => {
    const rs = rows.filter((r) => r.role === role);
    if (!rs.length) return [];
    const aspects: Record<string, number> = {};
    for (const a of RATING_ASPECTS[role]) {
      const v = rs.map((r) => json<Record<string, number>>(r.scores)[a.key]).filter((n): n is number => !!n);
      aspects[a.key] = v.length ? Math.round((v.reduce((x, y) => x + y, 0) / v.length) * 10) / 10 : 0;
    }
    return [
      {
        role,
        count: rs.length,
        average: ratingAverage(aspects),
        aspects,
        byMatch: rs.filter((r) => r.matchId).length,
        overall: rs.filter((r) => !r.matchId).length,
        recent: rs.slice(0, 5).map((r) => ({ by: r.raterName, comment: r.comment ?? undefined, at: r.at.toISOString(), average: ratingAverage(json<Record<string, number>>(r.scores)), matchLabel: r.matchId ? labels.get(r.matchId) : undefined })),
      },
    ];
  });
}

/**
 * What the viewer may rate this person for, on every path (playing, scoring, umpiring, the ground,
 * coaching): each completed match they were both part of, once; and the path overall, once, for
 * anyone who has worked with them in it or who runs a club or league.
 */
async function rateableBy(u: P.User, viewer: User | undefined, paths: Partial<Record<Rated, Match[]>>): Promise<PersonProfile['rateable']> {
  if (!viewer || viewer.id === u.id) return [];
  const mine = await prisma.rating.findMany({ where: { userId: u.id, raterId: viewer.id }, select: { role: true, matchId: true } });
  const done = (role: string, matchId?: string) => mine.some((r) => r.role === role && (r.matchId ?? undefined) === matchId);
  const all = Object.values(paths).flat();
  const orgOf = new Map((await prisma.competition.findMany({ where: { id: { in: all.map((m) => m.competitionId!).filter(Boolean) } }, select: { id: true, orgId: true } })).map((c) => [c.id, c.orgId]));
  // Part of the match: ran it, runs either club, played in it, or officiated it.
  const involved = (m: Match) => {
    const orgId = m.competitionId ? orgOf.get(m.competitionId) : undefined;
    const xi = Object.values(m.playingXI ?? {}).flat();
    const o = m.officials;
    return (
      (!!orgId && isLeagueAdmin(viewer, orgId)) ||
      isClubAdmin(viewer, m.homeTeamId) ||
      isClubAdmin(viewer, m.awayTeamId) ||
      m.createdBy === viewer.id ||
      (!!viewer.playerId && xi.includes(viewer.playerId)) ||
      o.scorerUserId === viewer.id ||
      !!o.umpireUserIds?.includes(viewer.id) ||
      !!o.groundsmanUserIds?.includes(viewer.id)
    );
  };
  const finished = (ms: Match[] = []) => ms.filter((m) => m.status === 'completed' && involved(m));
  const labels = await matchLabels(all);
  const runsSomething = viewer.memberships.some((x) => x.role === 'owner' || x.role === 'leagueAdmin' || x.role === 'clubAdmin');
  const theirs = new Set<Rated>([...officiatingOf(u).roles, ...(u.playerId ? (['player'] as const) : [])]);
  const out: PersonProfile['rateable'] = [];
  for (const role of RATED) {
    const shared = finished(paths[role]);
    // The ten most recent matches they shared, newest first.
    for (const m of shared.slice(0, 10)) if (!done(role, m.id)) out.push({ role, matchId: m.id, label: labels.get(m.id) ?? 'A match' });
    if ((shared.length || (runsSomething && theirs.has(role))) && !done(role)) out.push({ role, label: `Overall as ${RATED_LABEL[role].toLowerCase()}` });
  }
  return out;
}

async function person(u: P.User, opts: { withMatches: boolean; played?: Map<string, number>; viewer?: User }): Promise<PersonProfile> {
  const [certs, regions, memberships, scored, umpired, prepared, teams] = await Promise.all([
    prisma.certificate.findMany({ where: { userId: u.id }, orderBy: { uploadedAt: 'desc' } }),
    prisma.region.findMany(),
    prisma.membership.findMany({ where: { userId: u.id } }),
    prisma.match.findMany({ where: { scorerUserId: u.id, status: { in: ACTIVE } }, orderBy: { startsAt: 'desc' } }),
    matchIdsWithOfficial('umpireUserIds', u.id).then((ids) => prisma.match.findMany({ where: { id: { in: ids }, status: { in: ACTIVE } }, orderBy: { startsAt: 'desc' } })),
    matchIdsWithOfficial('groundsmanUserIds', u.id).then((ids) => prisma.match.findMany({ where: { id: { in: ids }, status: { in: ACTIVE } }, orderBy: { startsAt: 'desc' } })),
    prisma.team.findMany({ where: { staff: { array_contains: [{ userId: u.id, role: 'coach' }] } }, select: { id: true, staff: true } }),
  ]);
  const coachedIds = teams.filter((t) => json<StaffMember[]>(t.staff).some((s) => s.userId === u.id && s.role === 'coach')).map((t) => t.id);
  const coached = coachedIds.length ? await prisma.match.count({ where: { status: 'completed', OR: [{ homeTeamId: { in: coachedIds } }, { awayTeamId: { in: coachedIds } }] } }) : 0;
  const officiating: OfficiatingProfile = {
    ...officiatingOf(u),
    certificates: certs.map((c) => ({ id: c.id, role: c.role as OfficialRole, title: c.title, issuer: c.issuer, year: c.year, fileName: c.fileName, fileUrl: `/api/v1/certificates/${c.id}/file`, status: c.status as 'pending' | 'verified' | 'rejected', uploadedAt: c.uploadedAt.toISOString() })),
  };
  let played = 0;
  if (u.playerId) played = opts.played?.get(u.playerId) ?? aggregate(await replayedMatches()).get(u.playerId)?.matches ?? 0;
  // Matches they played in, newest first, for rating them as a player.
  const playedIn = opts.withMatches && opts.viewer && u.playerId ? (await replayedMatches()).filter((r) => r.setup.teams.some((t) => t.players.some((p) => p.id === u.playerId))).map((r) => r.match).sort((a, b) => b.startsAt.localeCompare(a.startsAt)) : [];
  return {
    userId: u.id,
    name: u.name,
    city: u.city ?? undefined,
    regionId: regions.find((r) => u.city && json<string[]>(r.cities).includes(u.city))?.id,
    playerId: u.playerId ?? undefined,
    clubIds: [...new Set([...memberships.filter((m) => m.clubId).map((m) => m.clubId!), ...coachedIds])],
    officiating,
    stats: { scored: scored.length, umpired: umpired.length, played, coached, groundsman: prepared.length },
    scored: opts.withMatches ? scored.slice(0, 10).map(toMatch) : [],
    umpired: opts.withMatches ? umpired.slice(0, 10).map(toMatch) : [],
    prepared: opts.withMatches ? prepared.slice(0, 10).map(toMatch) : [],
    memberSince: u.createdAt.toISOString(),
    playing: json<PersonProfile['playing'] | null>(u.playing) ?? undefined,
    ratings: await ratingSummaries(u.id),
    rateable: opts.withMatches ? await rateableBy(u, opts.viewer, { player: playedIn, scorer: scored.map(toMatch), umpire: umpired.map(toMatch), groundsman: prepared.map(toMatch) }) : [],
  };
}

async function userRow(id: string) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('Person');
  return u;
}

export async function peopleRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/people/:id', async (req) => person(await userRow(req.params.id), { withMatches: true, viewer: req.user }));

  // Rate an official's work: someone who was part of the match, once per match and role.
  app.post<{ Params: { id: string } }>('/people/:id/ratings', async (req) => {
    const user = requireUser(req);
    const b = z.object({ role: z.enum(RATED), matchId: z.string().optional(), scores: z.record(z.string(), z.number().int().min(1).max(5)), comment: z.string().trim().max(280).optional() }).parse(req.body);
    const u = await userRow(req.params.id);
    const profile = await person(u, { withMatches: true, viewer: user });
    if (!profile.rateable.some((r) => r.role === b.role && r.matchId === b.matchId)) throw forbidden(b.matchId ? 'Only people who were part of that match can rate it, once' : 'Only people who have worked with them, or club and league admins, can rate this, once');
    const problem = ratingProblem(b.role, b.scores);
    if (problem) throw badRequest(problem);
    await prisma.rating.create({ data: { id: newId('rate'), userId: u.id, raterId: user.id, raterName: user.name, role: b.role, matchId: b.matchId ?? null, scores: toJson(b.scores), comment: b.comment || null } });
    await notify(u.id, { kind: 'official', title: `New rating as ${RATED_LABEL[b.role].toLowerCase()}`, body: `${user.name} rated ${b.matchId ? 'how you did in a match' : 'you overall'}${b.comment ? `: “${b.comment.slice(0, 80)}”` : '.'}`, link: { pathname: '/person/[id]', params: { id: u.id } } });
    return person(u, { withMatches: true, viewer: user });
  });

  // How you play. Mirrored onto your player profile, if you have one.
  app.patch('/me/playing', async (req) => {
    const user = requireUser(req);
    const b = z.object({ role: z.enum(['batter', 'bowler', 'allRounder', 'keeper']), battingHand: z.enum(['R', 'L']), bowlingStyle: z.string().trim().max(40).optional() }).parse(req.body);
    const playing = { role: b.role, battingHand: b.battingHand, bowlingStyle: b.bowlingStyle || undefined };
    await prisma.user.update({ where: { id: user.id }, data: { playing: toJson(playing) } });
    if (user.playerId) await prisma.player.update({ where: { id: user.playerId }, data: { role: b.role, battingHand: b.battingHand, bowlingStyle: b.bowlingStyle || null } });
    return loadUser(user.id);
  });

  app.patch('/me/officiating', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({ roles: z.array(z.enum(ROLES)).optional(), available: z.boolean().optional(), days: z.array(z.enum(DAYS)).optional(), awayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like 2027-04-04')).max(366).optional(), travelKm: z.number().int().min(1).max(500).optional(), fee: z.number().int().min(0).optional(), bio: z.string().max(600).optional(), grounds: z.array(z.string().trim().min(1)).max(10).optional() })
      .parse(req.body);
    const u = await userRow(user.id);
    // Away dates: each once, in order, and none already past.
    const today = new Date().toISOString().slice(0, 10);
    if (b.awayDates) b.awayDates = [...new Set(b.awayDates)].filter((d) => d >= today).sort();
    await prisma.user.update({ where: { id: user.id }, data: { officiating: toJson({ ...officiatingOf(u), ...b }) } });
    return person(await userRow(user.id), { withMatches: true });
  });

  app.post('/me/certificates', async (req) => {
    const user = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('Attach the certificate as a file');
    if (!/^(application\/pdf|image\/(png|jpe?g|webp|heic))$/.test(file.mimetype)) throw badRequest('Use a PDF or a photo');
    const f = file.fields as Record<string, { value?: string } | undefined>;
    const meta = z
      .object({ role: z.enum(ROLES), title: z.string().trim().min(1, 'Add the certificate name'), issuer: z.string().trim().min(1, 'Add who issued it'), year: z.coerce.number().int().min(1950).max(2100), fileName: z.string().default(file.filename) })
      .parse({ role: f.role?.value, title: f.title?.value, issuer: f.issuer?.value, year: f.year?.value, fileName: f.fileName?.value ?? file.filename });
    const id = newId('cert');
    const key = `certificates/${user.id}/${id}-${meta.fileName.replace(/[^\w.-]/g, '_')}`;
    await storage.put(key, await file.toBuffer(), file.mimetype);
    await prisma.certificate.create({ data: { id, userId: user.id, ...meta, fileKey: key, status: 'pending' } });
    // Uploading a certificate for a role adds the role.
    const u = await userRow(user.id);
    const o = officiatingOf(u);
    if (!o.roles.includes(meta.role)) await prisma.user.update({ where: { id: user.id }, data: { officiating: toJson({ ...o, roles: [...o.roles, meta.role] }) } });
    return person(await userRow(user.id), { withMatches: true });
  });

  app.delete<{ Params: { id: string } }>('/me/certificates/:id', async (req) => {
    const user = requireUser(req);
    await prisma.certificate.deleteMany({ where: { id: req.params.id, userId: user.id } });
    return person(await userRow(user.id), { withMatches: true });
  });

  // The document itself: only its owner and league admins may open it.
  app.get<{ Params: { id: string } }>('/certificates/:id/file', async (req, reply) => {
    const user = requireUser(req);
    const c = await prisma.certificate.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound('Certificate');
    // The file can hold personal details, so only its owner and Ovalcast staff (who verify it) open it.
    // Everyone else sees the certificate's name, issuer and whether staff verified it.
    if (c.userId !== user.id && !user.staff) throw forbidden('Only the certificate’s owner and Ovalcast staff can open the file');
    const data = await storage.get(c.fileKey).catch(() => {
      throw notFound('Certificate file');
    });
    return reply.header('Content-Type', c.fileName.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg').header('Content-Disposition', `inline; filename="${c.fileName}"`).send(data);
  });

  app.get('/officials', async (req) => {
    const q = z.object({ regionId: z.string().optional(), role: z.enum(ROLES).optional(), availableOnly: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), minRating: z.coerce.number().min(1).max(5).optional() }).parse(req.query);
    const region = q.regionId ? await prisma.region.findUnique({ where: { id: q.regionId } }) : null;
    const cities = region ? json<string[]>(region.cities) : undefined;
    const rows = (await prisma.user.findMany({ where: { officiating: { not: Prisma.AnyNull } } }))
      .filter((u) => officiatingOf(u).roles.length > 0)
      .filter((u) => !cities || cities.includes(u.city ?? ''))
      .filter((u) => !q.role || officiatingOf(u).roles.includes(q.role))
      .filter((u) => !q.availableOnly || officiatingOf(u).available);
    // Free on a date: open to invites, free that weekday, not away, and not already appointed that day.
    let free = rows;
    if (q.date) {
      const weekday = DAYS[(new Date(`${q.date}T12:00:00Z`).getUTCDay() + 6) % 7];
      const booked = await bookedOn(q.date);
      free = rows.filter((u) => {
        const o = officiatingOf(u);
        return o.available && o.days.includes(weekday) && !(o.awayDates ?? []).includes(q.date!) && !booked.has(u.id);
      });
    }
    const played = new Map([...aggregate(await replayedMatches())].map(([id, f]) => [id, f.matches]));
    let people = await Promise.all(free.map((u) => person(u, { withMatches: false, played })));
    // Their rating for the role asked about, or their best as an official.
    const rating = (p: PersonProfile) => Math.max(0, ...p.ratings.filter((r) => (q.role ? r.role === q.role : r.role !== 'player')).map((r) => r.average));
    if (q.minRating) people = people.filter((p) => rating(p) >= q.minRating!);
    // Available first, then the best rated, then verified certificates, then experience.
    const verified = (p: PersonProfile) => p.officiating.certificates.filter((c) => c.status === 'verified').length;
    return people.sort((a, b) => Number(b.officiating.available) - Number(a.officiating.available) || rating(b) - rating(a) || verified(b) - verified(a) || b.stats.scored + b.stats.umpired - (a.stats.scored + a.stats.umpired));
  });
}
