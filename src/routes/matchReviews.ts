// After a league match: whether each captain has reviewed the officials (due within 48 hours), and the
// match referee's report to the league. The league sees everything; captains, clubs and officials of
// the match see the statuses; the report itself is for the league and the referee.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MatchReviews } from '@/api/types';
import { json, prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden } from '~/lib/errors';
import { captainReviewDone, captainUserFor, officialsToReview, REVIEW_HOURS } from '~/lib/matchReviews';
import { isClubAdmin, mayApprovePlayers, notify, orgAdminIds } from '~/lib/repo';
import { getMatch } from '~/services/matches';

export async function matchReviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/matches/:id/reviews', async (req): Promise<MatchReviews> => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    if (!m.competitionId) throw badRequest('Reviews are for league matches');
    const orgId = (await prisma.competition.findUniqueOrThrow({ where: { id: m.competitionId }, select: { orgId: true } })).orgId;
    const league = mayApprovePlayers(user, orgId);
    const o = m.officials;
    const captains = await Promise.all([m.homeTeamId, m.awayTeamId].map(async (teamId) => ({ teamId, userId: await captainUserFor(m.id, teamId) })));
    const involved = league || isClubAdmin(user, m.homeTeamId) || isClubAdmin(user, m.awayTeamId) || o.refereeUserId === user.id || !!o.umpireUserIds?.includes(user.id) || captains.some((c) => c.userId === user.id);
    if (!involved) throw forbidden('Only the league, the clubs and the match’s officials see its reviews');
    const dues = await prisma.matchReviewDue.findMany({ where: { matchId: m.id } });
    const names = new Map((await prisma.user.findMany({ where: { id: { in: captains.map((c) => c.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const report = await prisma.refereeReport.findUnique({ where: { matchId: m.id } });
    const deadline = (askedAt?: Date) => (askedAt ? new Date(askedAt.getTime() + REVIEW_HOURS * 3_600_000).toISOString() : undefined);
    return {
      matchId: m.id,
      needsReferee: m.status !== 'completed' && !o.refereeUserId,
      officialsToReview: officialsToReview(m).length,
      captains: await Promise.all(captains.map(async (c) => {
        const due = dues.find((d) => d.kind === 'captain' && d.teamId === c.teamId);
        const done = !!c.userId && m.status === 'completed' && (await captainReviewDone(m, c.userId));
        return { teamId: c.teamId, userId: c.userId, name: c.userId ? (names.get(c.userId) ?? 'Captain') : undefined, done, dueBy: deadline(due?.askedAt), overdue: !done && !!due?.flaggedAt, mine: c.userId === user.id };
      })),
      referee: o.refereeUserId ? { userId: o.refereeUserId, name: o.refereeName ?? 'Match referee', reported: !!report, dueBy: deadline(dues.find((d) => d.kind === 'referee')?.askedAt), overdue: !report && !!dues.find((d) => d.kind === 'referee')?.flaggedAt, mine: o.refereeUserId === user.id } : undefined,
      // The report itself: for the league and the referee who wrote it.
      ...(report && (league || o.refereeUserId === user.id)
        ? { report: { conduct: json<Record<string, number>>(report.conduct), pitch: report.pitch, incidents: report.incidents, reported: json<{ name: string; teamId?: string; note: string }[]>(report.reported), by: report.refereeName, at: report.updatedAt.toISOString() } }
        : {}),
    };
  });

  // The match referee's report, after the match: each side's conduct and the pitch (1 to 5), incidents,
  // and anyone to report. They can correct it; the league is told when it arrives.
  app.put<{ Params: { id: string } }>('/matches/:id/referee-report', async (req) => {
    const user = requireUser(req);
    const m = await getMatch(req.params.id);
    if (m.officials.refereeUserId !== user.id) throw forbidden('Only the match referee files the match report');
    if (m.status !== 'completed') throw conflict('File the report once the match has finished');
    const score = z.number().int().min(1).max(5);
    const b = z.object({
      conduct: z.record(z.string(), score),
      pitch: score,
      incidents: z.string().trim().max(2000).default(''),
      reported: z.array(z.object({ name: z.string().trim().min(1).max(80), teamId: z.string().optional(), note: z.string().trim().min(1, 'Say why').max(500) })).max(10).default([]),
    }).parse(req.body);
    if (![m.homeTeamId, m.awayTeamId].every((t) => b.conduct[t] >= 1)) throw badRequest('Score both sides’ conduct');
    const first = !(await prisma.refereeReport.findUnique({ where: { matchId: m.id }, select: { matchId: true } }));
    const data = { refereeId: user.id, refereeName: user.name, conduct: toJson(b.conduct), pitch: b.pitch, incidents: b.incidents, reported: toJson(b.reported) };
    await prisma.refereeReport.upsert({ where: { matchId: m.id }, create: { matchId: m.id, ...data }, update: data });
    await prisma.matchReviewDue.updateMany({ where: { matchId: m.id, kind: 'referee', doneAt: null }, data: { doneAt: new Date() } });
    if (first && m.competitionId) {
      const orgId = (await prisma.competition.findUniqueOrThrow({ where: { id: m.competitionId }, select: { orgId: true } })).orgId;
      await notify(await orgAdminIds(orgId), { kind: 'official', title: 'Match report filed', body: `${user.name} filed the referee’s report${b.reported.length ? `, reporting ${b.reported.length} ${b.reported.length === 1 ? 'person' : 'people'}` : ''}.`, link: { pathname: '/match/[id]', params: { id: m.id } } });
    }
    return { ok: true as const };
  });

}
