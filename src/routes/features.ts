// Scorer handover and reassignment, rules documents, player claims,
// milestones, going live and YouTube keys, and the organisation's API keys.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createOrganisation, newOrganisationSchema } from '~/services/organisations';
import { refundIfMostlyDown } from '~/services/billing';
import type { ApiClientSummary, LiveSetup, MatchEligibility, MatchLineups, Organisation, PlayerClaim, TeamSheet, RulesDocumentVersion, Stream } from '@/api/types';
import { milestoneChase, milestoneLines, playerShotProfile } from '@/engine';
import type * as P from '~/generated/prisma/client';
import { json, Prisma, prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { sha256, sixDigitCode } from '~/lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { publish } from '~/lib/live';
import { isClubAdmin, isLeagueAdmin, notify, toCompetition, toMatch, toOrg } from '~/lib/repo';
import { seal } from '~/lib/secrets';
import { storage } from '~/lib/storage';
import { requireFeature } from '~/services/billing';
import { forgetDevice, getMatch, saveMatch } from '~/services/matches';
import { emitPartnerEvent } from '~/services/partners';
import { ballEventsFor } from '~/services/matches';
import { replayedMatches } from '~/services/stats';
import { eligibilityFor } from '~/routes/matches';

const HANDOVER_MINUTES = 10;

const toClaim = (c: P.PlayerClaim): PlayerClaim => ({ ...c, status: c.status as PlayerClaim['status'], note: c.note ?? undefined, createdAt: c.createdAt.toISOString(), respondedAt: c.respondedAt?.toISOString() });
const toStream = (s: P.Stream): Stream => ({ id: s.id, matchId: s.matchId, status: s.status as Stream['status'], playbackUrl: s.playbackUrl, viewers: s.viewers, latencySeconds: s.latencySeconds, source: s.source as Stream['source'], streamer: s.streamer, liveSeconds: s.liveSeconds, downSeconds: s.downSeconds, refunded: !!s.refundedAt || undefined });
const ruleUrl = (competitionId: string, version: number) => `/api/v1/competitions/${competitionId}/rules/${version}/file`;

async function orgOfMatch(competitionId?: string) {
  if (!competitionId) return undefined;
  return (await prisma.competition.findUnique({ where: { id: competitionId }, select: { orgId: true } }))?.orgId;
}

/** A player and every typed-in or guest record whose matches the same user has claimed. */
export async function playerAliases(playerId: string) {
  const owner = await prisma.user.findFirst({ where: { playerId }, select: { id: true } });
  if (!owner) return [playerId];
  const claimed = await prisma.player.findMany({ where: { claimedByUserId: owner.id }, select: { id: true } });
  return [playerId, ...claimed.map((p) => p.id)];
}

export async function featureRoutes(app: FastifyInstance) {
  // ------------------------------------------------- scoring on one phone
  app.post<{ Params: { id: string } }>('/matches/:id/handover', async (req) => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    if (m.officials.scorerUserId !== user.id) throw forbidden('Only the scorer can hand the match over');
    const code = sixDigitCode();
    const expiresAt = new Date(Date.now() + HANDOVER_MINUTES * 60_000);
    await prisma.scorerHandover.upsert({ where: { matchId: m.id }, create: { matchId: m.id, codeHash: sha256(code), fromUser: user.id, expiresAt }, update: { codeHash: sha256(code), fromUser: user.id, expiresAt, attempts: 0 } });
    return { matchId: m.id, code, expiresAt: expiresAt.toISOString() };
  });

  app.post<{ Params: { id: string } }>('/matches/:id/handover/claim', async (req) => {
    const user = requireUser(req);
    const { code } = z.object({ code: z.string().trim().min(4) }).parse(req.body);
    const deviceId = req.headers['x-device-id'] as string | undefined;
    const h = await prisma.scorerHandover.findUnique({ where: { matchId: req.params.id } });
    if (!h || h.expiresAt < new Date() || h.attempts >= 5) throw badRequest('That code has expired. Ask the scorer for a new one.');
    if (h.codeHash !== sha256(code)) {
      await prisma.scorerHandover.update({ where: { matchId: h.matchId }, data: { attempts: { increment: 1 } } });
      throw badRequest('That code is wrong. Check it with the scorer.');
    }
    const m = await getMatch(h.matchId);
    // A league match only moves between accounts the league could have assigned; the code is the scorer's consent.
    m.officials = { ...m.officials, scorerUserId: user.id, scorerName: user.name };
    await saveMatch(m);
    await prisma.$transaction([prisma.match.update({ where: { id: m.id }, data: { scoringDeviceId: deviceId ?? null } }), prisma.scorerHandover.delete({ where: { matchId: m.id } })]);
    forgetDevice(m.id);
    if (h.fromUser !== user.id) await notify(h.fromUser, { kind: 'official', title: `${user.name} took over scoring`, body: 'Your phone can no longer enter balls for this match.', link: { pathname: '/match/[id]', params: { id: m.id } } });
    publish(m.id, { type: 'status', match: m });
    return m;
  });

  app.post<{ Params: { id: string } }>('/matches/:id/scorer', async (req) => {
    const user = requireUser(req);
    const { userId } = z.object({ userId: z.string() }).parse(req.body);
    const m = await getMatch(req.params.id);
    const orgId = await orgOfMatch(m.competitionId);
    if (!orgId || !isLeagueAdmin(user, orgId)) throw forbidden('Only a league admin can reassign the scorer');
    const to = await prisma.user.findUnique({ where: { id: userId } });
    if (!to) throw notFound('Person');
    const from = m.officials.scorerUserId;
    m.officials = { ...m.officials, scorerUserId: to.id, scorerName: to.name };
    await saveMatch(m);
    // The new scorer's first ball claims the match for their phone.
    await prisma.match.update({ where: { id: m.id }, data: { scoringDeviceId: null } });
    forgetDevice(m.id);
    await notify(to.id, { kind: 'official', title: 'You are now scoring a match', body: 'A league admin moved scoring to you. Open the match to carry on.', link: { pathname: '/match/[id]', params: { id: m.id } } });
    if (from && from !== to.id) await notify(from, { kind: 'official', title: 'Scoring moved to someone else', body: `A league admin gave this match to ${to.name}.`, link: { pathname: '/match/[id]', params: { id: m.id } } });
    return m;
  });

  // ------------------------------------------------------ rules documents
  app.get<{ Params: { id: string } }>('/competitions/:id/rules', async (req): Promise<RulesDocumentVersion[]> => {
    const rows = await prisma.ruleDocument.findMany({ where: { competitionId: req.params.id }, orderBy: { version: 'desc' } });
    return rows.map((r) => ({ version: r.version, name: r.name, sizeKb: r.sizeKb, uploadedAt: r.uploadedAt.toISOString(), uploadedByName: r.uploadedByName, fileUrl: ruleUrl(r.competitionId, r.version) }));
  });

  app.post<{ Params: { id: string } }>('/competitions/:id/rules', async (req) => {
    const user = requireUser(req);
    const c = await prisma.competition.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound('Competition');
    if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can upload the rules');
    await requireFeature(c.orgId, 'rulesDocument', 'Uploading a rules document');
    const file = await req.file();
    if (!file) throw badRequest('Attach the rules as a file');
    const word = /^application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/.test(file.mimetype);
    if (file.mimetype !== 'application/pdf' && !word) throw badRequest('Use a PDF or Word file');
    const data = await file.toBuffer();
    const last = await prisma.ruleDocument.findFirst({ where: { competitionId: c.id }, orderBy: { version: 'desc' } });
    const version = (last?.version ?? 0) + 1;
    const name = file.filename.replace(/[^\w. -]/g, '_');
    const key = `rules/${c.id}/v${version}-${name}`;
    await storage.put(key, data, file.mimetype);
    const at = new Date();
    await prisma.ruleDocument.create({ data: { id: newId('rule'), competitionId: c.id, version, name, sizeKb: Math.ceil(data.length / 1024), fileKey: key, uploadedBy: user.id, uploadedByName: user.name, uploadedAt: at } });
    const saved = await prisma.competition.update({ where: { id: c.id }, data: { rulesDocument: toJson({ name, version, uploadedAt: at.toISOString(), sizeKb: Math.ceil(data.length / 1024) }) } });
    return toCompetition(saved);
  });

  // Rules are public, so clubs and umpires read the same version.
  app.get<{ Params: { id: string; version: string } }>('/competitions/:id/rules/:version/file', async (req, reply) => {
    const version = Number(req.params.version);
    const r = Number.isInteger(version) ? await prisma.ruleDocument.findUnique({ where: { competitionId_version: { competitionId: req.params.id, version } } }) : null;
    if (!r) throw notFound('Rules document');
    const data = await storage.get(r.fileKey).catch(() => {
      throw notFound('Rules file');
    });
    return reply.header('Content-Type', r.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('Content-Disposition', `inline; filename="${r.name}"`).send(data);
  });

  // ---------------------------------------------------------------- claims
  app.post<{ Params: { id: string } }>('/players/:id/claims', async (req) => {
    const user = requireUser(req);
    const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    const p = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound('Player');
    if (p.id === user.playerId) throw conflict('That is already you');
    if (p.claimedByUserId) throw conflict('This player has already been claimed');
    if (await prisma.playerClaim.count({ where: { playerId: p.id, status: 'pending' } })) throw conflict('Someone has already claimed this player');
    const claim = await prisma.playerClaim.create({ data: { id: newId('claim'), playerId: p.id, playerName: p.name, teamId: p.teamId, userId: user.id, userName: user.name, status: 'pending', note: note ?? null } });
    const admins = await prisma.membership.findMany({ where: { clubId: p.teamId, role: 'clubAdmin' }, select: { userId: true } });
    await notify(admins.map((a) => a.userId), { kind: 'entry', title: `${user.name} claims matches as ${p.name}`, body: 'Approve only if this is the same person.', link: { pathname: '/team/[id]', params: { id: p.teamId } } });
    return toClaim(claim);
  });

  app.get<{ Params: { id: string } }>('/teams/:id/claims', async (req) => {
    const user = requireUser(req);
    if (!isClubAdmin(user, req.params.id)) throw forbidden('Only the club admin can see claims');
    return (await prisma.playerClaim.findMany({ where: { teamId: req.params.id }, orderBy: { createdAt: 'desc' } })).map(toClaim);
  });

  app.post<{ Params: { id: string } }>('/claims/:id/respond', async (req) => {
    const user = requireUser(req);
    const { response } = z.object({ response: z.enum(['approve', 'reject']) }).parse(req.body);
    const c = await prisma.playerClaim.findUnique({ where: { id: req.params.id } });
    if (!c) throw notFound('Claim');
    if (!isClubAdmin(user, c.teamId)) throw forbidden('Only the club admin can decide a claim');
    if (c.status !== 'pending') throw conflict('This claim is already decided');
    const status = response === 'approve' ? 'approved' : 'rejected';
    const [saved] = await prisma.$transaction([
      prisma.playerClaim.update({ where: { id: c.id }, data: { status, respondedAt: new Date() } }),
      ...(status === 'approved' ? [prisma.player.update({ where: { id: c.playerId }, data: { claimedByUserId: c.userId } })] : []),
    ]);
    await notify(c.userId, { kind: 'entry', title: status === 'approved' ? 'Your claim was approved' : 'Your claim was turned down', body: `${c.playerName}'s matches ${status === 'approved' ? 'now count on your profile' : 'stay as they are'}.` });
    return toClaim(saved as P.PlayerClaim);
  });

  // ------------------------------------------------------------ milestones
  app.get<{ Params: { id: string } }>('/players/:id/milestones', async (req) => {
    const p = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound('Player');
    const ids = await playerAliases(p.id);
    const comps = new Map((await prisma.competition.findMany({ select: { id: true, ballType: true } })).map((c) => [c.id, c.ballType as 'leather' | 'tennis']));
    const replays = (await replayedMatches()).map((r) => ({ match: { ...r.match, locked: r.match.locked }, ballType: comps.get(r.match.competitionId ?? '') ?? 'leather', state: r.state, events: r.events }));
    return { playerId: p.id, ...milestoneChase(milestoneLines(ids, replays)) };
  });

  // ------------------------------------------------------------ going live
  app.post<{ Params: { id: string } }>('/matches/:id/streams', async (req): Promise<LiveSetup> => {
    const user = requireUser(req);
    const { source } = z.object({ source: z.enum(['phone', 'encoder']) }).parse(req.body);
    const m = await getMatch(req.params.id);
    const orgId = await orgOfMatch(m.competitionId);
    // Organisers decide who streams their matches: league admins, the scorer, and the two clubs' admins.
    const allowed = orgId ? isLeagueAdmin(user, orgId) || m.officials.scorerUserId === user.id || isClubAdmin(user, m.homeTeamId) || isClubAdmin(user, m.awayTeamId) : m.createdBy === user.id || m.officials.scorerUserId === user.id;
    if (!allowed) throw forbidden(orgId ? 'Only people the league allows can stream its matches' : 'Only the people running this friendly can stream it');
    // One live stream per match, even when two requests arrive together (a double tap, two devices):
    // the match's lock is held while checking and creating.
    const { stream: s, created } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${m.id}))`;
      const existing = await tx.stream.findFirst({ where: { matchId: m.id, status: { not: 'ended' } } });
      if (existing) return { stream: existing, created: false };
      // Development stand-in for a Cloudflare Stream live input; production creates one through its API.
      const liveInputId = `li_${newId('x').slice(2)}`;
      const row = await tx.stream.create({ data: { id: newId('stream'), matchId: m.id, status: 'live', playbackUrl: `https://customer-dev.cloudflarestream.com/${liveInputId}/manifest/video.m3u8`, viewers: 0, latencySeconds: source === 'phone' ? 5 : 8, source, streamer: user.name, liveInputId, startedBy: user.id } });
      return { stream: row, created: true };
    });
    // Older streams have no live input of their own: their id stands in, so the key never changes between calls.
    const liveInputId = s.liveInputId ?? s.id;
    if (created) {
      m.streamId = s.id;
      await saveMatch(m);
      // Pages already open on the match show "Watch live" straight away.
      publish(m.id, { type: 'status', match: m });
      void emitPartnerEvent('stream.live', m.id, { streamId: s.id });
    }
    const paid = !!(await prisma.passOffer.findUnique({ where: { matchId: m.id } }));
    const yt = await prisma.youTubeKey.findFirst({ where: { ownerId: { in: [orgId ?? '', m.homeTeamId] } } });
    return {
      stream: toStream(s),
      ingest: { protocol: 'rtmps', url: 'rtmps://live.cloudflare.com:443/live/', streamKey: liveInputId },
      // The website serves the overlay: a transparent page for OBS or vMix, with the client's logo and sponsors.
      overlayUrl: `${process.env.WEB_URL ?? 'https://ovalcast.app'}/overlay/${m.id}`,
      youtube: paid ? 'blockedPaid' : yt ? 'restreaming' : 'notConnected',
    };
  });

  app.post<{ Params: { id: string } }>('/streams/:id/end', async (req) => {
    const user = requireUser(req);
    const s = await prisma.stream.findUnique({ where: { id: req.params.id }, include: { match: { select: { competitionId: true } } } });
    if (!s) throw notFound('Stream');
    const orgId = await orgOfMatch(s.match.competitionId ?? undefined);
    if (s.startedBy !== user.id && !(orgId && isLeagueAdmin(user, orgId))) throw forbidden('Only whoever started the stream can end it');
    await prisma.stream.update({ where: { id: s.id }, data: { status: 'ended' } });
    await refundIfMostlyDown(s.id);
    // Watchers and the match page hear it has ended.
    publish(s.matchId, { type: 'status', match: await getMatch(s.matchId) });
    return toStream((await prisma.stream.findUnique({ where: { id: s.id } }))!);
  });

  // The host's phone reports, every 30 seconds, how long the picture has reached viewers and how long it hasn't.
  app.post<{ Params: { id: string } }>('/streams/:id/health', async (req) => {
    const user = requireUser(req);
    const b = z.object({ liveSeconds: z.number().min(0).max(86_400), downSeconds: z.number().min(0).max(86_400) }).parse(req.body);
    const s = await prisma.stream.findUnique({ where: { id: req.params.id } });
    if (!s) throw notFound('Stream');
    if (s.startedBy !== user.id) throw forbidden('Only whoever started the stream reports on it');
    // Totals only grow, so a late or repeated report can't shrink them.
    return toStream(await prisma.stream.update({ where: { id: s.id }, data: { liveSeconds: Math.max(s.liveSeconds, Math.round(b.liveSeconds)), downSeconds: Math.max(s.downSeconds, Math.round(b.downSeconds)) } }));
  });

  const youtube = (kind: 'organisation' | 'team') => async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const user = requireUser(req);
    const { streamKey } = z.object({ streamKey: z.string().trim().nullable() }).parse(req.body);
    const ok = kind === 'organisation' ? isLeagueAdmin(user, req.params.id) : isClubAdmin(user, req.params.id);
    if (!ok) throw forbidden('Only an admin can connect YouTube');
    if (streamKey === null) {
      await prisma.youTubeKey.deleteMany({ where: { ownerId: req.params.id } });
      return { connected: false };
    }
    if (!/^[\w-]{8,64}$/.test(streamKey)) throw badRequest('Paste the stream key from YouTube Studio');
    await prisma.youTubeKey.upsert({ where: { ownerId: req.params.id }, create: { ownerId: req.params.id, ownerKind: kind, keyEnc: seal(streamKey) }, update: { keyEnc: seal(streamKey), updatedAt: new Date() } });
    return { connected: true };
  };
  app.put<{ Params: { id: string } }>('/organisations/:id/youtube', youtube('organisation'));
  app.put<{ Params: { id: string } }>('/teams/:id/youtube', youtube('team'));

  // ------------------------------------------------------- team sheets
  const toSheet = (t: P.TeamSheet): TeamSheet => ({ matchId: t.matchId, teamId: t.teamId, playerIds: json<string[]>(t.playerIds), reserves: json<string[]>(t.reserves), captainId: t.captainId ?? undefined, keeperId: t.keeperId ?? undefined, submittedBy: t.submittedBy, submittedByName: t.submittedByName, submittedAt: t.submittedAt.toISOString() });
  const ROLE_ORDER: Record<string, number> = { keeper: 0, batter: 1, allRounder: 2, bowler: 3 };

  /** What the scorer starts from: the club's team sheet, else its last XI, else a balanced side. Only eligible players. */
  app.get<{ Params: { id: string } }>('/matches/:id/lineups', async (req): Promise<MatchLineups> => {
    const m = await getMatch(req.params.id);
    const elig = await eligibilityFor(m.id);
    const sheets = (await prisma.teamSheet.findMany({ where: { matchId: m.id } })).map(toSheet);
    const sides = [m.homeTeamId, m.awayTeamId];
    const out: MatchLineups = { matchId: m.id, teams: {} };
    const practiceClub = m.practice ? (await prisma.team.findUnique({ where: { id: m.homeTeamId }, select: { parentTeamId: true } }))?.parentTeamId : undefined;
    let split: string[][] | undefined;
    if (practiceClub) {
      const pool = (await prisma.player.findMany({ where: { teamId: practiceClub, guest: false } })).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
      split = [pool.filter((_, i) => i % 2 === 0).slice(0, 11).map((p) => p.id), pool.filter((_, i) => i % 2 === 1).slice(0, 11).map((p) => p.id)];
    }
    for (const [side, teamId] of sides.entries()) {
      const ok = new Set((elig.teams[teamId] ?? []).filter((x) => x.ok).map((x) => x.playerId));
      const sheet = sheets.find((x) => x.teamId === teamId);
      if (sheet) {
        out.teams[teamId] = { sheet, suggested: sheet.playerIds.filter((id) => ok.has(id)), captainId: sheet.captainId, keeperId: sheet.keeperId, source: 'teamSheet' };
        continue;
      }
      if (split) {
        out.teams[teamId] = { suggested: split[side], source: 'squad' };
        continue;
      }
      const squad = (await prisma.player.findMany({ where: { id: { in: [...ok] }, guest: false } })).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
      const topUp = (ids: string[]) => [...ids, ...squad.map((p) => p.id).filter((id) => !ids.includes(id))].slice(0, 11);
      const last = await prisma.match.findFirst({ where: { id: { not: m.id }, OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }], startsAt: { lt: new Date(m.startsAt) }, status: { notIn: ['scheduled', 'toss'] }, playingXI: { not: Prisma.AnyNull } }, orderBy: { startsAt: 'desc' } });
      const lastXi = last ? json<Record<string, string[]> | null>(last.playingXI)?.[teamId] : undefined;
      if (last && lastXi) {
        const leaders = json<Record<string, { captainId?: string; keeperId?: string }> | null>(last.leaders)?.[teamId];
        const xiNow = topUp(lastXi.filter((id) => ok.has(id)));
        const keeper = leaders?.keeperId ?? (await prisma.player.findFirst({ where: { id: { in: xiNow }, role: 'keeper' }, select: { id: true } }))?.id;
        out.teams[teamId] = { suggested: xiNow, captainId: leaders?.captainId, keeperId: keeper, source: 'lastMatch', lastMatch: { matchId: last.id, date: last.startsAt.toISOString(), opponentId: last.homeTeamId === teamId ? last.awayTeamId : last.homeTeamId } };
        continue;
      }
      out.teams[teamId] = { suggested: topUp([]), keeperId: squad.find((p) => p.role === 'keeper')?.id, source: 'squad' };
    }
    return out;
  });

  app.put<{ Params: { id: string; teamId: string } }>('/matches/:id/team-sheets/:teamId', async (req) => {
    const user = requireUser(req);
    const b = z.object({ playerIds: z.array(z.string()).min(2).max(11), reserves: z.array(z.string()).max(10).default([]), captainId: z.string().optional(), keeperId: z.string().optional() }).parse(req.body);
    const m = await getMatch(req.params.id);
    const teamId = req.params.teamId;
    if (teamId !== m.homeTeamId && teamId !== m.awayTeamId) throw badRequest('That club is not in this match');
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId } });
    const staff = json<{ userId?: string; role: string }[]>(team.staff);
    if (!isClubAdmin(user, teamId) && !staff.some((x) => x.userId === user.id && (x.role === 'captain' || x.role === 'coach'))) throw forbidden('Only the club’s admins, captain or coach can submit its team sheet');
    if (m.status !== 'scheduled' && m.status !== 'toss') throw conflict('The match has started; the scorer has the XI now');
    if (new Set(b.playerIds).size !== b.playerIds.length) throw badRequest('A player is listed twice');
    if (b.captainId && !b.playerIds.includes(b.captainId)) throw badRequest('The captain must be in the XI');
    if (b.keeperId && !b.playerIds.includes(b.keeperId)) throw badRequest('The wicketkeeper must be in the XI');
    // Only players this club may field in this match.
    const elig = await eligibilityFor(m.id);
    const ok = new Set((elig.teams[teamId] ?? []).filter((x) => x.ok).map((x) => x.playerId));
    const bad = [...b.playerIds, ...b.reserves].find((id) => !ok.has(id));
    if (bad) throw conflict('Someone on the sheet cannot play in this match. Check the eligibility notes.');
    const data = { playerIds: toJson(b.playerIds), reserves: toJson(b.reserves.filter((r) => !b.playerIds.includes(r))), captainId: b.captainId ?? null, keeperId: b.keeperId ?? null, submittedBy: user.id, submittedByName: user.name, submittedAt: new Date() };
    const saved = await prisma.teamSheet.upsert({ where: { matchId_teamId: { matchId: m.id, teamId } }, create: { matchId: m.id, teamId, ...data }, update: data });
    if (m.officials.scorerUserId && m.officials.scorerUserId !== user.id) await notify(m.officials.scorerUserId, { kind: 'match', title: `${team.name} sent their team sheet`, body: 'It is ready in match setup.', link: { pathname: '/match/[id]', params: { id: m.id } } });
    return toSheet(saved);
  });

  // ------------------------------------------------------------ shot profile
  app.get<{ Params: { id: string } }>('/players/:id/shots', async (req) => {
    const p = await prisma.player.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound('Player');
    const ids = await playerAliases(p.id);
    // Matches this player (or a claimed record) batted or bowled in.
    const rows = await prisma.ballEvent.findMany({ where: { OR: [{ strikerId: { in: ids } }, { bowlerId: { in: ids } }] }, select: { matchId: true }, distinct: ['matchId'] });
    const matches = await Promise.all(rows.map((r) => ballEventsFor(r.matchId)));
    // Claimed records count as the player.
    const as = (e: import('@/engine').BallEvent) => ({ ...e, strikerId: ids.includes(e.strikerId) ? p.id : e.strikerId, bowlerId: ids.includes(e.bowlerId) ? p.id : e.bowlerId });
    return { playerId: p.id, leftHanded: p.battingHand === 'L', ...playerShotProfile(p.id, matches.map((evs) => evs.map(as))) };
  });

  // ----------------------------------------------------------- organisations
  /** Anyone who runs cricket starts an organisation and becomes its owner, on the Free plan. */
  app.post('/organisations', async (req): Promise<Organisation> => {
    const user = requireUser(req);
    const org = await createOrganisation(user, newOrganisationSchema.parse(req.body));
    return toOrg(org, [], []);
  });

  // --------------------------------------------------------- API clients
  const toClient = async (c: P.ApiClient & { webhooks: P.PartnerWebhook[] }): Promise<ApiClientSummary> => ({
    id: c.id, name: c.name, keyPrefix: c.keyPrefix, sandbox: c.sandbox, createdAt: c.createdAt.toISOString(), lastUsedAt: c.lastUsedAt?.toISOString(), revokedAt: c.revokedAt?.toISOString(),
    requestsThisMonth: c.usageMonth === new Date().toISOString().slice(0, 7) ? c.requestsThisMonth : 0,
    webhooks: c.webhooks.map((w) => ({ id: w.id, url: w.url, events: json<string[]>(w.events), active: w.active })),
  });

  app.get<{ Params: { id: string } }>('/organisations/:id/api-clients', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only league admins can see API keys');
    return Promise.all((await prisma.apiClient.findMany({ where: { orgId: req.params.id }, include: { webhooks: true }, orderBy: { createdAt: 'desc' } })).map(toClient));
  });

  app.delete<{ Params: { id: string; clientId: string } }>('/organisations/:id/api-clients/:clientId', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only league admins can revoke API keys');
    const c = await prisma.apiClient.findFirst({ where: { id: req.params.clientId, orgId: req.params.id } });
    if (!c) throw notFound('API key');
    return toClient(await prisma.apiClient.update({ where: { id: c.id }, data: { revokedAt: c.revokedAt ?? new Date() }, include: { webhooks: true } }));
  });
}

