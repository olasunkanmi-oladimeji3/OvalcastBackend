// Matches: friendlies, start and lock, the ball log, the live feed, the online
// toss, eligibility and guests, and invitations to score or umpire.

import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BallEventInput, Match, MatchEligibility, OfficialInvite, TossSession, User } from '@/api/types';
import { clubWhenClubsMeet, otherLeagueConflicts, type BallEvent } from '@/engine';
import type * as P from '~/generated/prisma/client';
import { isUniqueViolation, json, prisma } from '~/db/client';
import { openFeed } from '~/lib/rateLimit';
import { requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { publish, subscribe, trackFeed } from '~/lib/live';
import { isClubAdmin, isLeagueAdmin, matchData, notify, toCompetition, toMatch, toPlayer, toRegistration } from '~/lib/repo';
import { ballEventsFor, ballStored, forgetDevice, forgetSetups, getMatch, getMatchCached, matchChangedAt, refreshFromEvents, saveMatch, scoringDevice, storedBall, T20 } from '~/services/matches';
import { checkMatchStart } from '~/services/billing';
import { emitPartnerEvent } from '~/services/partners';

const isScorer = (u: User, m: Match) => m.officials.scorerUserId === u.id;

/** League admins appoint officials for league matches; for friendlies, the creator or either club's admin. */
async function canManageOfficials(u: User, m: Match) {
  if (m.competitionId) {
    const c = await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } });
    return isLeagueAdmin(u, c?.orgId);
  }
  return m.createdBy === u.id || isClubAdmin(u, m.homeTeamId) || isClubAdmin(u, m.awayTeamId);
}

/**
 * Who may run the toss: the scorer, whoever runs the match (league admins; for a friendly, its
 * creator), and either club's admins, who are at the ground. Never once play has started.
 */
async function mayRunToss(u: User, m: Match) {
  if (m.status !== 'scheduled' && m.status !== 'toss') throw conflict('The toss is done: this match has started');
  if (isScorer(u, m) || isClubAdmin(u, m.homeTeamId) || isClubAdmin(u, m.awayTeamId) || (await canManageOfficials(u, m))) return;
  throw forbidden('Only the scorer, the organiser or a club admin can run the toss');
}

const toInvite = (i: P.OfficialInvite): OfficialInvite => ({ ...i, role: i.role as OfficialInvite['role'], status: i.status as OfficialInvite['status'], note: i.note ?? undefined, createdAt: i.createdAt.toISOString() });

const ballSchema = z.object({
  clientId: z.string().min(4).max(80),
  innings: z.number().int().min(1).max(4),
  seq: z.number().int().min(1),
  kind: z.enum(['delivery', 'void']),
  voidOf: z.string().optional(),
  strikerId: z.string(),
  nonStrikerId: z.string(),
  bowlerId: z.string(),
  bat: z.number().int().min(0).max(8),
  boundary: z.boolean().optional(),
  extra: z.object({ kind: z.enum(['wide', 'noBall', 'bye', 'legBye', 'penalty']), runs: z.number().int().min(0).max(8), nbVia: z.enum(['bat', 'bye', 'legBye']).optional() }).optional(),
  wicket: z.object({ kind: z.enum(['bowled', 'caught', 'lbw', 'stumped', 'runOut', 'hitWicket', 'obstructing', 'hitTwice', 'timedOut', 'retiredOut', 'retiredHurt']), playerOutId: z.string(), fielderId: z.string().optional() }).optional(),
  newBatterId: z.string().optional(),
  shot: z.object({ angle: z.number(), distance: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).optional(),
});

/** Stores a ball once per client id (offline syncs retry), recalculates the match and tells the live feed. */
export async function recordBall(m: Match, input: Omit<BallEvent, 'id' | 'matchId' | 'createdAt' | 'createdBy'>, userId: string): Promise<BallEvent> {
  // A retried offline sync: answer from memory with the ball already stored.
  const existing = await storedBall(m.id, input.clientId);
  if (existing) return existing;
  const event: BallEvent = { ...input, id: newId(input.kind === 'void' ? 'void' : 'ball'), matchId: m.id, createdAt: new Date().toISOString(), createdBy: userId };
  try {
    await prisma.ballEvent.create({ data: { id: event.id, matchId: m.id, clientId: event.clientId, innings: event.innings, seq: event.seq, kind: event.kind, event: event as never, strikerId: event.strikerId ?? null, bowlerId: event.bowlerId ?? null, createdBy: userId, createdAt: event.createdAt } });
  } catch (e) {
    // Lost a race with the same client id: return the stored one.
    if (!isUniqueViolation(e)) throw e;
    const row = await prisma.ballEvent.findUniqueOrThrow({ where: { matchId_clientId: { matchId: m.id, clientId: input.clientId } } });
    return json<BallEvent>(row.event);
  }
  ballStored(m.id, event);
  const before = m.status;
  await refreshFromEvents(m, before);
  publish(m.id, { type: event.kind === 'void' ? 'void' : 'ball', event });
  publish(m.id, { type: 'status', match: m });
  // Partner webhooks for the organisation that owns the match.
  if (event.kind === 'delivery' && event.wicket) void emitPartnerEvent('wicket', m.id, { ballEventId: event.id, innings: event.innings, wicket: event.wicket, scores: m.scores });
  if (before !== m.status && m.status === 'inningsBreak') void emitPartnerEvent('innings.ended', m.id, { scores: m.scores });
  if (before !== m.status && m.status === 'completed') void emitPartnerEvent('match.completed', m.id, { scores: m.scores, result: m.result });
  return event;
}

/**
 * Why a ball can't be stored, or undefined. Everyone it names must be in the right XI: the batters,
 * the batter out and the new batter in the batting side's, the bowler in the bowling side's. The
 * fielder can be anyone (substitute fielders). Innings alternate: odd innings (including a super
 * over's first) bat the side that batted first.
 */
function ballProblem(m: Match, input: BallEventInput): string | undefined {
  if (!m.playingXI || !m.battingFirstTeamId) return undefined;
  const first = m.battingFirstTeamId;
  const second = first === m.homeTeamId ? m.awayTeamId : m.homeTeamId;
  const [batting, bowling] = input.innings % 2 === 1 ? [first, second] : [second, first];
  const bat = new Set(m.playingXI[batting] ?? []);
  const bowl = new Set(m.playingXI[bowling] ?? []);
  if (!bat.size || !bowl.size) return undefined;
  if (!bat.has(input.strikerId) || !bat.has(input.nonStrikerId)) return 'The batters must be in the batting side’s XI';
  if (input.strikerId === input.nonStrikerId) return 'The two batters must be different players';
  if (!bowl.has(input.bowlerId)) return 'The bowler must be in the fielding side’s XI';
  if (input.wicket && !bat.has(input.wicket.playerOutId)) return 'The batter out must be in the batting side’s XI';
  if (input.newBatterId && !bat.has(input.newBatterId)) return 'The new batter must be in the batting side’s XI';
  return undefined;
}

/** A friendly side's players; practice sides pick from their club's squad. */
async function squadIds(teamId: string) {
  const parent = (await prisma.team.findUnique({ where: { id: teamId }, select: { parentTeamId: true } }))?.parentTeamId;
  return (await prisma.player.findMany({ where: { guest: false, teamId: { in: parent ? [teamId, parent] : [teamId] } }, select: { id: true } })).map((p) => p.id);
}

/** One phone at a time: the first ball claims the match for that device; another needs a handover code. */
async function checkDevice(matchId: string, deviceId: string | undefined) {
  // Without a device the one-phone rule could be skipped, so balls always need one (every app sends it).
  if (!deviceId || deviceId.length < 4) throw badRequest('Update Ovalcast to score: this version doesn’t identify the device.');
  const current = await scoringDevice(matchId);
  if (!current) {
    await prisma.match.updateMany({ where: { id: matchId, scoringDeviceId: null }, data: { scoringDeviceId: deviceId } });
    forgetDevice(matchId);
  } else if (current !== deviceId) throw conflict('This match is being scored on another phone. Ask the scorer for a handover code.');
}

/** Who can play in a match, and why not. Reads only the two squads' players and the leagues they're in. */
export async function eligibilityFor(matchId: string): Promise<MatchEligibility> {
  const m = await getMatchCached(matchId);
  const cRow = m.competitionId ? await prisma.competition.findUnique({ where: { id: m.competitionId } }) : null;
  const c = cRow ? toCompetition(cRow) : undefined;
  const knockout = !!c && c.stages.find((s) => s.id === m.stageId)?.kind === 'knockout';
  // This league's two squads, then every registration those players have anywhere (for clashes
  // with other leagues and second clubs), and only the competitions those registrations are in.
  const squadPlayerIds = c ? (await prisma.registration.findMany({ where: { competitionId: c.id, teamId: { in: [m.homeTeamId, m.awayTeamId] } }, select: { playerId: true } })).map((r) => r.playerId) : [];
  const [regs, guests] = await Promise.all([
    c ? prisma.registration.findMany({ where: { playerId: { in: squadPlayerIds } } }).then((rs) => rs.map(toRegistration)) : Promise.resolve([]),
    prisma.player.findMany({ where: { guestMatchId: m.id } }),
  ]);
  const comps = c ? await prisma.competition.findMany({ where: { id: { in: [...new Set(regs.map((r) => r.competitionId))] } } }) : [];
  const groupMatches = c ? (await prisma.match.findMany({ where: { competitionId: c.id, status: 'completed' } })).map(toMatch).filter((x) => c.stages.find((s) => s.id === x.stageId)?.kind !== 'knockout') : [];
  const out: MatchEligibility = { matchId: m.id, guestPlayersAllowed: c ? c.playerRules.guestPlayersPerXI : 11, knockout, teams: {} };
  for (const teamId of [m.homeTeamId, m.awayTeamId]) {
    const other = teamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId;
    const registered = c ? regs.filter((r) => r.competitionId === c.id && r.teamId === teamId && r.status === 'active').map((r) => r.playerId) : await squadIds(teamId);
    const teamGuests = guests.filter((g) => g.teamId === teamId).map((g) => g.id);
    out.teams[teamId] = [...registered, ...teamGuests].map((playerId) => {
      if (teamGuests.includes(playerId)) return { playerId, ok: true, reason: 'Guest for this match', appearances: 0 };
      const apps = groupMatches.filter((x) => (x.homeTeamId === teamId || x.awayTeamId === teamId) && (x.playingXI?.[teamId] ?? []).includes(playerId)).length;
      if (c) {
        const plays = clubWhenClubsMeet(playerId, c.id, [teamId, other], regs);
        if (plays && plays !== teamId) return { playerId, ok: false, reason: 'Plays for their first club when these clubs meet', appearances: apps };
        const clash = otherLeagueConflicts(playerId, c, comps.map(toCompetition), regs)[0];
        if (clash) return { playerId, ok: false, reason: clash.reason, appearances: apps };
        const hold = regs.find((r) => r.competitionId === c.id && r.playerId === playerId && r.teamId === teamId && r.status === 'active' && r.heldReason);
        if (hold) return { playerId, ok: false, reason: `Held by the league's player rules: ${hold.heldReason}`, appearances: apps };
        if (c.playerRules.squadApproval && regs.some((r) => r.competitionId === c.id && r.playerId === playerId && r.teamId === teamId && r.status === 'active' && r.approved === false)) return { playerId, ok: false, reason: 'Waiting for the league to approve the squad', appearances: apps };
        if (knockout && apps < c.playerRules.minMatchesForKnockouts) return { playerId, ok: false, reason: `Played ${apps} of the ${c.playerRules.minMatchesForKnockouts} group matches needed`, appearances: apps };
      }
      return { playerId, ok: true, appearances: apps };
    });
  }
  return out;
}

export async function matchRoutes(app: FastifyInstance) {
  app.get('/matches', async (req) => {
    const q = z.object({ status: z.string().optional(), competitionId: z.string().optional(), teamId: z.string().optional() }).parse(req.query);
    const rows = await prisma.match.findMany({
      where: { ...(q.status ? { status: { in: q.status.split(',') } } : {}), ...(q.competitionId ? { competitionId: q.competitionId } : {}), ...(q.teamId ? { OR: [{ homeTeamId: q.teamId }, { awayTeamId: q.teamId }] } : {}) },
      orderBy: { startsAt: 'asc' },
    });
    return rows.map(toMatch);
  });

  app.get<{ Params: { id: string } }>('/matches/:id', async (req) => getMatchCached(req.params.id));

  app.post('/matches', async (req) => {
    const user = requireUser(req);
    const side = z.object({ teamId: z.string().optional(), name: z.string().optional() });
    const b = z
      .object({ home: side, away: side, venue: z.string().default(''), startsAt: z.string(), oversPerInnings: z.number().int().min(1).max(50), ballType: z.enum(['leather', 'tennis']), scorer: z.union([z.literal('me'), z.object({ inviteUserId: z.string() })]).optional(), practice: z.object({ teamId: z.string(), sides: z.tuple([z.string(), z.string()]) }).optional() })
      .parse(req.body);
    const overs = b.oversPerInnings;
    const conditions = { ...T20, oversPerInnings: overs, maxOversPerBowler: Math.max(1, Math.ceil(overs / 5)), powerplayOvers: Math.max(1, Math.round(overs * 0.3)), freeHit: b.ballType === 'leather' };
    if (b.practice) {
      // A practice match at training: two sides that both pick from the club's squad.
      const club = await prisma.team.findUnique({ where: { id: b.practice.teamId } });
      if (!club) throw notFound('Club');
      const staff = json<{ userId?: string }[]>(club.staff);
      if (!isClubAdmin(user, club.id) && !staff.some((x) => x.userId === user.id)) throw forbidden('Only the club’s admins and staff can set up a practice match');
      const colours = json<string[]>(club.colors);
      const sides = await Promise.all(
        b.practice.sides.map((name, i) =>
          prisma.team.create({ data: { id: newId('prac'), name: name.trim() || `${club.shortName} ${i ? 'B' : 'A'}`, shortName: `${club.shortName.slice(0, 2)}${i ? 'B' : 'A'}`, colors: i ? [colours[1] ?? '#F7F8F1', colours[0]] : colours, homeGround: club.homeGround, city: club.city, founded: club.founded, staff: [], adHoc: true, parentTeamId: club.id } }),
        ),
      );
      const pm: Match = { id: newId('m'), title: 'Practice match', homeTeamId: sides[0].id, awayTeamId: sides[1].id, venue: b.venue.trim() || club.homeGround, startsAt: b.startsAt, status: 'scheduled', officials: { umpires: [], scorerUserId: user.id, scorerName: user.name }, scores: [], locked: false, friendly: true, practice: true, createdBy: user.id, conditions };
      await prisma.match.create({ data: { id: pm.id, ...matchData(pm) } });
      return pm;
    }
    const resolve = async (s: z.infer<typeof side>) => {
      if (s.teamId) {
        const t = await prisma.team.findUnique({ where: { id: s.teamId } });
        if (!t) throw notFound('Team');
        return t;
      }
      const name = s.name?.trim();
      if (!name) throw badRequest('Pick or name both sides');
      // A quick side for street or social cricket, with numbered players the scorer can rename later.
      const id = newId('adhoc');
      const short = name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'XI';
      const t = await prisma.team.create({ data: { id, name, shortName: short, colors: ['#47604F', '#F7F8F1'], homeGround: b.venue || 'Local ground', city: user.city ?? '', founded: new Date().getFullYear(), staff: [], adHoc: true } });
      await prisma.player.createMany({ data: Array.from({ length: 11 }, (_, i) => ({ id: `${id}_p${i + 1}`, teamId: id, name: `${name} player ${i + 1}`, shortName: `${short} ${i + 1}`, role: i < 6 ? 'batter' : 'bowler', battingHand: 'R' })) });
      return t;
    };
    const home = await resolve(b.home);
    const away = await resolve(b.away);
    if (home.id === away.id) throw badRequest('A side cannot play itself');
    const m: Match = {
      id: newId('m'), title: 'Friendly', homeTeamId: home.id, awayTeamId: away.id, venue: b.venue.trim() || home.homeGround, startsAt: b.startsAt, status: 'scheduled',
      officials: { umpires: [], scorerUserId: user.id, scorerName: user.name }, scores: [], locked: false, friendly: true, createdBy: user.id,
      conditions,
    };
    await prisma.match.create({ data: { id: m.id, ...matchData(m) } });
    // Inviting someone else: the creator stays scorer until they accept.
    if (b.scorer && b.scorer !== 'me') {
      const invitee = await prisma.user.findUnique({ where: { id: b.scorer.inviteUserId } });
      if (invitee && invitee.id !== user.id) {
        await prisma.officialInvite.create({ data: { id: newId('oinv'), matchId: m.id, userId: invitee.id, userName: invitee.name, role: 'scorer', invitedBy: user.id, invitedByName: user.name, status: 'pending' } });
        await notify(invitee.id, { kind: 'official', title: `${user.name} invited you to score`, body: `${home.name} v ${away.name}, ${m.venue}. Accept or decline on the match.`, link: { pathname: '/match/[id]', params: { id: m.id } } });
      }
    }
    return m;
  });

  app.post<{ Params: { id: string } }>('/matches/:id/start', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({
        battingFirstTeamId: z.string(), playingXI: z.record(z.string(), z.array(z.string()).min(2).max(11)), openers: z.tuple([z.string(), z.string()]), openingBowlerId: z.string(),
        leaders: z.record(z.string(), z.object({ captainId: z.string().optional(), keeperId: z.string().optional() })).optional(),
      })
      .parse(req.body);
    const m = await getMatch(req.params.id);
    if (!isScorer(user, m)) throw forbidden('Only the assigned scorer can start this match');
    if (!m.homeTeamId || !m.awayTeamId) throw conflict('Both teams are not known yet');
    if (m.status !== 'scheduled' && m.status !== 'toss') throw conflict('This match has already started');
    const orgId = m.competitionId ? (await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } }))?.orgId : undefined;
    await checkMatchStart(orgId, user.id);
    if (m.competitionId) {
      const c = toCompetition(await prisma.competition.findUniqueOrThrow({ where: { id: m.competitionId } }));
      for (const [teamId, ids] of Object.entries(b.playingXI)) {
        const regs = await prisma.registration.findMany({ where: { competitionId: m.competitionId, teamId, status: 'active' }, select: { playerId: true } });
        const guests = await prisma.player.findMany({ where: { guestMatchId: m.id, teamId }, select: { id: true } });
        const ok = new Set([...regs.map((r) => r.playerId), ...guests.map((g) => g.id)]);
        const bad = ids.find((pid) => !ok.has(pid));
        if (bad) throw conflict(`A player in the XI is not registered with this club for ${c.name}`);
        if (ids.filter((pid) => guests.some((g) => g.id === pid)).length > c.playerRules.guestPlayersPerXI) throw conflict(`${c.name} allows ${c.playerRules.guestPlayersPerXI} guest players per XI`);
      }
    }
    const bowlingTeam = b.battingFirstTeamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId;
    m.battingFirstTeamId = b.battingFirstTeamId;
    // Openers lead the batting XI; the opening bowler goes last so the first over defaults to them.
    m.playingXI = {
      ...b.playingXI,
      [b.battingFirstTeamId]: [...b.openers, ...b.playingXI[b.battingFirstTeamId].filter((p) => !b.openers.includes(p))],
      [bowlingTeam]: [...b.playingXI[bowlingTeam].filter((p) => p !== b.openingBowlerId), b.openingBowlerId],
    };
    if (b.leaders) m.leaders = b.leaders;
    m.status = 'live';
    m.scores = [{ teamId: b.battingFirstTeamId, runs: 0, wickets: 0, balls: 0, allOut: false }];
    await saveMatch(m);
    await prisma.match.update({ where: { id: m.id }, data: { startedAt: new Date() } });
    publish(m.id, { type: 'status', match: m });
    void emitPartnerEvent('match.started', m.id, { homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, battingFirstTeamId: m.battingFirstTeamId });
    return m;
  });

  app.post<{ Params: { id: string } }>('/matches/:id/lock', async (req) => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    if (!isScorer(user, m) && !(await canManageOfficials(user, m))) throw forbidden('Only the scorer or the organiser can lock this match');
    if (m.status !== 'completed') throw conflict('Only a finished match can be locked');
    m.locked = true;
    await saveMatch(m);
    return m;
  });

  // ---------------------------------------------------------------- ball log
  // Every ball, or with ?after=<ball id> only the balls since then (how viewers catch up).
  app.get<{ Params: { id: string } }>('/matches/:id/balls', async (req) => {
    const { after } = z.object({ after: z.string().optional() }).parse(req.query);
    const events = await ballEventsFor(req.params.id);
    if (!after) return events;
    const i = events.findIndex((e) => e.id === after);
    return i < 0 ? events : events.slice(i + 1);
  });

  app.post<{ Params: { id: string } }>('/matches/:id/balls', async (req) => {
    const user = requireUser(req);
    const input = ballSchema.parse(req.body) as BallEventInput;
    const m = await getMatch(req.params.id);
    if (!isScorer(user, m)) throw forbidden('Only the assigned scorer can enter balls for this match');
    if (m.locked) throw conflict('This match is locked');
    if (!m.battingFirstTeamId) throw conflict('Start the match before scoring');
    await checkDevice(m.id, req.headers['x-device-id'] as string | undefined);
    // A resent ball that's already stored is answered as it was, even if the XI changed since.
    const problem = (await storedBall(m.id, input.clientId)) ? undefined : ballProblem(m, input);
    if (problem) throw badRequest(problem);
    return recordBall(m, input, user.id);
  });

  app.post<{ Params: { id: string; eventId: string } }>('/matches/:id/balls/:eventId/void', async (req) => {
    const user = requireUser(req);
    const { clientId } = z.object({ clientId: z.string().min(4) }).parse(req.body);
    const m = await getMatch(req.params.id);
    if (!isScorer(user, m)) throw forbidden('Only the assigned scorer can change balls for this match');
    if (m.locked) throw conflict('This match is locked');
    await checkDevice(m.id, req.headers['x-device-id'] as string | undefined);
    const target = await prisma.ballEvent.findFirst({ where: { matchId: m.id, OR: [{ id: req.params.eventId }, { clientId: req.params.eventId }] } });
    if (!target) throw notFound('Ball');
    const { id: _id, matchId: _m, createdAt: _c, createdBy: _b, ...rest } = json<BallEvent>(target.event);
    return recordBall(m, { ...rest, clientId, kind: 'void', voidOf: target.id }, user.id);
  });

  // Server-sent events: one message per ball, void or status change. Viewers never touch the
  // database: the match comes from memory and each message is sent as ready-made text.
  // A viewer reconnecting with Last-Event-ID gets only the messages they missed.
  // A viewer opening the feed says what their page already shows: ?balls=<how many> and
  // ?since=<when their copy of the match was read, ms>. Balls scored since come first, then the
  // match if it changed in the meantime (a stream started, the toss, a decision).
  app.get<{ Params: { id: string } }>('/matches/:id/live', async (req, reply) => {
    const match = await getMatchCached(req.params.id);
    const q = z.object({ lastEventId: z.string().optional(), balls: z.coerce.number().int().min(0).optional(), since: z.coerce.number().optional() }).parse(req.query);
    const after = Number(req.headers['last-event-id'] ?? q.lastEventId ?? 0) || undefined;
    const missed = !after && q.balls !== undefined ? (await ballEventsFor(req.params.id)).slice(q.balls) : [];
    // A couple of seconds' allowance for clocks on different machines.
    const changed = matchChangedAt(req.params.id);
    const stale = !after && q.since !== undefined && changed !== undefined && changed > q.since - 2000;
    const slot = openFeed(req);
    if ('refused' in slot) return reply.status(429).header('Retry-After', '30').send({ message: slot.refused, retryAfter: 30 });
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
    trackFeed(reply.raw);
    // Browsers reconnect after 3 seconds if the connection drops.
    reply.raw.write('retry: 3000\n: connected\n\n');
    const off = subscribe(req.params.id, (frame) => reply.raw.write(frame), after);
    for (const event of missed) reply.raw.write(`data: ${JSON.stringify({ type: event.kind === 'void' ? 'void' : 'ball', event })}\n\n`);
    if (missed.length || stale) reply.raw.write(`data: ${JSON.stringify({ type: 'status', match })}\n\n`);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      off();
      clearInterval(ping);
      slot.release();
    });
  });

  // ----------------------------------------------------------------- toss
  const toToss = (t: P.TossSession): TossSession => ({ matchId: t.matchId, code: t.code, callerTeamId: t.callerTeamId, call: (t.call ?? undefined) as TossSession['call'], outcome: (t.outcome ?? undefined) as TossSession['outcome'], wonByTeamId: t.wonByTeamId ?? undefined, decision: (t.decision ?? undefined) as TossSession['decision'], at: t.at?.toISOString() });

  app.post<{ Params: { id: string } }>('/matches/:id/toss', async (req) => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    await mayRunToss(user, m);
    const row = { matchId: m.id, code: String(randomInt(1000, 10000)), callerTeamId: m.awayTeamId, call: null, outcome: null, wonByTeamId: null, decision: null, at: null };
    const t = await prisma.tossSession.upsert({ where: { matchId: m.id }, create: row, update: row });
    return toToss(t);
  });

  app.post<{ Params: { id: string } }>('/matches/:id/toss/call', async (req) => {
    const user = requireUser(req);
    const { call } = z.object({ call: z.enum(['heads', 'tails']) }).parse(req.body);
    const m = await getMatch(req.params.id);
    await mayRunToss(user, m);
    const t = await prisma.tossSession.findUnique({ where: { matchId: m.id } });
    if (!t) throw notFound('Toss');
    if (t.outcome) throw conflict('The coin has already been tossed');
    // The server flips the coin, never either phone.
    const outcome = randomInt(2) === 0 ? 'heads' : 'tails';
    const won = outcome === call ? t.callerTeamId : t.callerTeamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId;
    const saved = await prisma.tossSession.update({ where: { matchId: m.id }, data: { call, outcome, wonByTeamId: won, at: new Date() } });
    return toToss(saved);
  });

  app.post<{ Params: { id: string } }>('/matches/:id/toss/decision', async (req) => {
    const user = requireUser(req);
    const { decision } = z.object({ decision: z.enum(['bat', 'bowl']) }).parse(req.body);
    const m = await getMatch(req.params.id);
    await mayRunToss(user, m);
    const t = await prisma.tossSession.findUnique({ where: { matchId: m.id } });
    if (!t?.wonByTeamId) throw conflict('The toss has not been called yet');
    const saved = await prisma.tossSession.update({ where: { matchId: m.id }, data: { decision } });
    m.toss = { wonByTeamId: t.wonByTeamId, decision, method: 'online', at: t.at!.toISOString() };
    if (m.status === 'scheduled') m.status = 'toss';
    await saveMatch(m);
    return toToss(saved);
  });

  // --------------------------------------------------- eligibility, guests
  app.get<{ Params: { id: string } }>('/matches/:id/eligibility', async (req): Promise<MatchEligibility> => eligibilityFor(req.params.id));

  app.post<{ Params: { id: string } }>('/matches/:id/guests', async (req) => {
    const user = requireUser(req);
    const { teamId, name } = z.object({ teamId: z.string(), name: z.string().trim().min(1, 'Add the guest’s name') }).parse(req.body);
    const m = await getMatch(req.params.id);
    if (!isScorer(user, m)) throw forbidden('Only the assigned scorer can add a guest');
    const c = m.competitionId ? toCompetition(await prisma.competition.findUniqueOrThrow({ where: { id: m.competitionId } })) : undefined;
    const allowed = c ? c.playerRules.guestPlayersPerXI : 11;
    const used = await prisma.player.count({ where: { guestMatchId: m.id, teamId } });
    if (used >= allowed) throw conflict(allowed === 0 ? 'This league does not allow guest players' : `This league allows ${allowed} guest${allowed === 1 ? '' : 's'} per XI`);
    const parts = name.split(/\s+/);
    const p = await prisma.player.create({ data: { id: newId('guest'), teamId, name, shortName: parts.length > 1 ? `${parts[0][0]}. ${parts.at(-1)}` : name, role: 'allRounder', battingHand: 'R', guest: true, guestMatchId: m.id } });
    forgetSetups();
    return toPlayer(p);
  });

  // ----------------------------------------------------- officials invites
  app.post<{ Params: { id: string } }>('/matches/:id/officials/invite', async (req) => {
    const user = requireUser(req);
    const { userId, role, note } = z.object({ userId: z.string(), role: z.enum(['scorer', 'umpire', 'groundsman']), note: z.string().optional() }).parse(req.body);
    const m = await getMatch(req.params.id);
    if (!(await canManageOfficials(user, m))) throw forbidden(m.competitionId ? 'Only a league admin can appoint officials for league matches' : 'Only the person who set up this friendly, or a club admin, can invite officials');
    if (m.status === 'completed') throw conflict('This match has finished');
    const invitee = await prisma.user.findUnique({ where: { id: userId } });
    if (!invitee) throw notFound('Person');
    if (role === 'scorer' && m.officials.scorerUserId === userId) throw conflict(`${invitee.name} is already the scorer`);
    if (role === 'umpire' && (m.officials.umpireUserIds?.length ?? 0) >= 2) throw conflict('This match already has two umpires');
    if (role === 'groundsman' && m.officials.groundsmanUserIds?.includes(userId)) throw conflict(`${invitee.name} is already preparing the ground`);
    const pending = await prisma.officialInvite.count({ where: { matchId: m.id, userId, role, status: 'pending' } });
    if (pending) throw conflict(`${invitee.name} already has an invitation`);
    const inv = await prisma.officialInvite.create({ data: { id: newId('oinv'), matchId: m.id, userId, userName: invitee.name, role, invitedBy: user.id, invitedByName: user.name, status: 'pending', note: note ?? null } });
    const names = await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, name: true } });
    const n = (id: string) => names.find((t) => t.id === id)?.name;
    await notify(userId, { kind: 'official', title: `${user.name} invited you to ${role === 'scorer' ? 'score' : role === 'groundsman' ? 'prepare the ground' : 'umpire'}`, body: `${n(m.homeTeamId)} v ${n(m.awayTeamId)}, ${m.venue}. Accept or decline on the match.`, link: { pathname: '/match/[id]', params: { id: m.id } } });
    return toInvite(inv);
  });

  // The organiser sets the whole match up at once: the ground, date, home side and every official.
  // People with accounts are invited (they're listed when they accept); officials without one are
  // listed by name straight away. Anyone taken off is told, and their invitation withdrawn.
  app.post<{ Params: { id: string } }>('/matches/:id/setup', async (req) => {
    const user = requireUser(req);
    const pick = z.union([z.object({ userId: z.string(), name: z.string().optional() }), z.object({ userId: z.undefined().optional(), name: z.string().trim().min(2, 'Give each official a name') })]);
    const b = z
      .object({
        startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))).optional(),
        venue: z.string().trim().min(1).max(80).optional(),
        homeTeamId: z.string().optional(),
        scorer: z.object({ userId: z.string() }).nullable().optional(),
        umpires: z.array(pick).max(2, 'Two umpires at most').optional(),
        groundsmen: z.array(pick).max(2, 'Two groundsmen at most').optional(),
        note: z.string().trim().max(200).optional(),
      })
      .parse(req.body);
    const m = await getMatch(req.params.id);
    if (!(await canManageOfficials(user, m))) throw forbidden(m.competitionId ? 'Only a league admin can set up league matches' : 'Only the person who set up this friendly, or a club admin, can set it up');
    if (m.status === 'completed' || m.status === 'abandoned') throw conflict('This match has finished');
    const notStarted = m.status === 'scheduled' || m.status === 'toss';
    if ((b.startsAt || b.homeTeamId) && !notStarted) throw conflict('The date and home side can’t change once play has started');

    if (b.startsAt) {
      m.startsAt = new Date(b.startsAt).toISOString();
      if (m.decision?.kind === 'postponed') m.decision = undefined;
    }
    if (b.homeTeamId && b.homeTeamId !== m.homeTeamId) {
      if (b.homeTeamId !== m.awayTeamId) throw badRequest('The home side has to be one of the two teams');
      if (m.toss) throw conflict('The toss is done: home and away can’t change now');
      const grounds = await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, homeGround: true } });
      const groundOf = (id: string) => grounds.find((g) => g.id === id)?.homeGround || undefined;
      const atOldHome = !b.venue && m.venue === groundOf(m.homeTeamId);
      [m.homeTeamId, m.awayTeamId] = [m.awayTeamId, m.homeTeamId];
      if (atOldHome && groundOf(m.homeTeamId)) m.venue = groundOf(m.homeTeamId)!;
    }
    if (b.venue) m.venue = b.venue;

    const pending = await prisma.officialInvite.findMany({ where: { matchId: m.id, status: 'pending' } });
    const invitations: { userId: string; role: 'scorer' | 'umpire' | 'groundsman' }[] = [];
    const removed: string[] = [];
    const short = (name: string) => (name.trim().includes(' ') ? `${name.trim()[0]}. ${name.trim().split(' ').at(-1)}` : name.trim());

    // Umpires and groundsmen: the list given is the list wanted.
    const settle = async (role: 'umpire' | 'groundsman', wanted: z.infer<typeof pick>[] | undefined) => {
      if (!wanted) return;
      const ids = role === 'umpire' ? (m.officials.umpireUserIds ?? []) : (m.officials.groundsmanUserIds ?? []);
      const names = role === 'umpire' ? m.officials.umpires : (m.officials.groundsmen ?? []);
      // Names on the match that belong to an account, in order, so they can be dropped together.
      const accountNames = new Map(ids.map((id, i) => [id, names[i]]));
      const keepIds = ids.filter((id) => wanted.some((w) => w.userId === id));
      const keepNames = keepIds.map((id) => accountNames.get(id)!).filter(Boolean);
      const typed = wanted.filter((w) => !w.userId).map((w) => short(w.name!));
      for (const id of ids) if (!keepIds.includes(id)) removed.push(id);
      for (const w of wanted) if (w.userId && !ids.includes(w.userId) && !pending.some((p) => p.userId === w.userId && p.role === role)) invitations.push({ userId: w.userId, role });
      // Invitations for this role that are no longer wanted are withdrawn.
      for (const p of pending.filter((p) => p.role === role && !wanted.some((w) => w.userId === p.userId))) await prisma.officialInvite.update({ where: { id: p.id }, data: { status: 'withdrawn' } });
      const nameList = [...keepNames, ...typed].slice(0, 2);
      if (role === 'umpire') m.officials = { ...m.officials, umpireUserIds: keepIds, umpires: nameList };
      else m.officials = { ...m.officials, groundsmanUserIds: keepIds, groundsmen: nameList };
    };
    await settle('umpire', b.umpires);
    await settle('groundsman', b.groundsmen);

    if (b.scorer === null) {
      if (!notStarted) throw conflict('Scoring has started: move it with a handover code instead');
      if (m.officials.scorerUserId) removed.push(m.officials.scorerUserId);
      m.officials = { ...m.officials, scorerUserId: undefined, scorerName: undefined };
      for (const p of pending.filter((p) => p.role === 'scorer')) await prisma.officialInvite.update({ where: { id: p.id }, data: { status: 'withdrawn' } });
    } else if (b.scorer && b.scorer.userId !== m.officials.scorerUserId && !pending.some((p) => p.role === 'scorer' && p.userId === b.scorer!.userId)) {
      invitations.push({ userId: b.scorer.userId, role: 'scorer' });
    }

    await saveMatch(m);
    const teams = await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, name: true } });
    const teamName = (id: string) => teams.find((t) => t.id === id)?.name;
    const where = `${teamName(m.homeTeamId)} v ${teamName(m.awayTeamId)}, ${m.venue}`;
    const people = await prisma.user.findMany({ where: { id: { in: invitations.map((t) => t.userId) } }, select: { id: true, name: true } });
    for (const t of invitations) {
      const invitee = people.find((p) => p.id === t.userId);
      if (!invitee) throw notFound('Person');
      await prisma.officialInvite.create({ data: { id: newId('oinv'), matchId: m.id, userId: t.userId, userName: invitee.name, role: t.role, invitedBy: user.id, invitedByName: user.name, status: 'pending', note: b.note || null } });
      await notify(t.userId, { kind: 'official', title: `${user.name} invited you to ${t.role === 'scorer' ? 'score' : t.role === 'groundsman' ? 'prepare the ground' : 'umpire'}`, body: `${where}. Accept or decline on the match.`, link: { pathname: '/match/[id]', params: { id: m.id } } });
    }
    if (removed.length) await notify(removed, { kind: 'official', title: 'You’re no longer on a match', body: `The organiser changed the officials for ${where}.`, link: { pathname: '/match/[id]', params: { id: m.id } } });
    publish(m.id, { type: 'status', match: m });
    return { match: m, invites: (await prisma.officialInvite.findMany({ where: { matchId: m.id } })).map(toInvite) };
  });

  app.get<{ Params: { id: string } }>('/matches/:id/officials/invites', async (req) => (await prisma.officialInvite.findMany({ where: { matchId: req.params.id } })).map(toInvite));

  app.get('/me/official-invites', async (req) => {
    const user = requireUser(req);
    return (await prisma.officialInvite.findMany({ where: { userId: user.id, status: 'pending' }, orderBy: { createdAt: 'desc' } })).map(toInvite);
  });

  app.post<{ Params: { id: string } }>('/official-invites/:id/respond', async (req) => {
    const user = requireUser(req);
    const { response } = z.object({ response: z.enum(['accept', 'decline', 'withdraw']) }).parse(req.body);
    const inv = await prisma.officialInvite.findUnique({ where: { id: req.params.id } });
    if (!inv) throw notFound('Invitation');
    if (inv.status !== 'pending') throw conflict('This invitation has already been answered');
    const m = await getMatch(inv.matchId);
    if (response === 'withdraw') {
      if (inv.invitedBy !== user.id && !(await canManageOfficials(user, m))) throw forbidden('Only whoever sent it can withdraw this');
      return toInvite(await prisma.officialInvite.update({ where: { id: inv.id }, data: { status: 'withdrawn' } }));
    }
    if (inv.userId !== user.id) throw forbidden('This invitation is for someone else');
    const status = response === 'accept' ? 'accepted' : 'declined';
    const saved = await prisma.officialInvite.update({ where: { id: inv.id }, data: { status } });
    if (status === 'accepted') {
      if (inv.role === 'scorer') {
        m.officials = { ...m.officials, scorerUserId: user.id, scorerName: user.name };
        await prisma.officialInvite.updateMany({ where: { matchId: m.id, role: 'scorer', status: 'pending' }, data: { status: 'withdrawn' } });
      } else if (inv.role === 'groundsman') {
        // Whoever prepares the ground: up to two.
        const short = `${user.name.split(' ')[0][0]}. ${user.name.split(' ').at(-1)}`;
        m.officials = { ...m.officials, groundsmanUserIds: [...(m.officials.groundsmanUserIds ?? []).filter((x) => x !== user.id), user.id].slice(-2), groundsmen: [...(m.officials.groundsmen ?? []).filter((x) => x !== short), short].slice(-2) };
      } else {
        const short = `${user.name.split(' ')[0][0]}. ${user.name.split(' ').at(-1)}`;
        m.officials = { ...m.officials, umpireUserIds: [...(m.officials.umpireUserIds ?? []), user.id].slice(0, 2), umpires: [...m.officials.umpires.filter((u) => u !== short), short].slice(-2) };
      }
      await saveMatch(m);
    }
    const doing = inv.role === 'scorer' ? 'score' : inv.role === 'groundsman' ? 'prepare the ground for' : 'umpire';
    await notify(inv.invitedBy, { kind: 'official', title: `${user.name} ${status === 'accepted' ? 'will' : 'can’t'} ${doing} your match`, body: status === 'accepted' ? 'They are now listed on the match.' : 'Invite someone else from Find officials.', link: { pathname: '/match/[id]', params: { id: m.id } } });
    return toInvite(saved);
  });
}
