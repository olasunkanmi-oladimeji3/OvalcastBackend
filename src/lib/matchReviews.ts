// After a league match: each side's captain reviews the officials (the umpires and the match referee)
// within 48 hours, and the referee files a report to the league. They're asked when the match ends,
// reminded at 24 hours and flagged to the league at 48. Checked by the background jobs.
import type { Match } from '@/api/types';
import { json, prisma } from '~/db/client';
import { newId } from '~/lib/ids';
import { clubAdminIds, notify, orgAdminIds, toMatch } from '~/lib/repo';

export const REVIEW_HOURS = 48;
const REMIND_HOURS = 24;

/** The person answering for a side: the captain on its team sheet, else the club's captain, else a club admin. */
export async function captainUserFor(matchId: string, teamId: string): Promise<string | undefined> {
  const sheet = await prisma.teamSheet.findUnique({ where: { matchId_teamId: { matchId, teamId } }, select: { captainId: true } });
  if (sheet?.captainId) {
    const owner = await prisma.user.findFirst({ where: { playerId: sheet.captainId }, select: { id: true } });
    if (owner) return owner.id;
    const claimed = await prisma.player.findUnique({ where: { id: sheet.captainId }, select: { claimedByUserId: true } });
    if (claimed?.claimedByUserId) return claimed.claimedByUserId;
  }
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { staff: true } });
  const captain = json<{ userId?: string; role: string }[]>(team?.staff ?? [])?.find((s) => s.role === 'captain' && s.userId);
  if (captain?.userId) return captain.userId;
  return (await clubAdminIds(teamId))[0];
}

/** Officials a captain reviews: the umpires and the referee who have Ovalcast accounts. */
export function officialsToReview(m: Match): { userId: string; role: 'umpire' | 'referee' }[] {
  const o = m.officials;
  return [...(o.umpireUserIds ?? []).map((id) => ({ userId: id, role: 'umpire' as const })), ...(o.refereeUserId ? [{ userId: o.refereeUserId, role: 'referee' as const }] : [])].filter((x) => !!x.userId);
}

/** Whether this person has rated every official they're meant to review for this match. */
export async function captainReviewDone(m: Match, userId: string) {
  const owed = officialsToReview(m).filter((o) => o.userId !== userId);
  if (!owed.length) return true;
  const given = await prisma.rating.findMany({ where: { raterId: userId, matchId: m.id }, select: { userId: true, role: true } });
  return owed.every((o) => given.some((g) => g.userId === o.userId && g.role === o.role));
}

/**
 * For league matches finished in the last ten days: ask each captain (and the referee) once,
 * mark what's done, remind at 24 hours and flag to the league at 48. Returns what it did.
 */
export async function runReviewChecks(now = new Date()) {
  // League matches that started in the last ten days and have finished. The 48 hours run from when
  // each person is first asked, which the jobs do within minutes of the match ending.
  const rows = await prisma.match.findMany({ where: { status: 'completed', competitionId: { not: null }, startsAt: { gte: new Date(now.getTime() - 10 * 86_400_000) } } });
  const out = { asked: 0, reminded: 0, flagged: 0 };
  for (const row of rows) {
    const m = toMatch(row);
    const orgId = (await prisma.competition.findUnique({ where: { id: row.competitionId! }, select: { orgId: true } }))?.orgId;
    if (!orgId) continue;
    const teams = await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, name: true, shortName: true } });
    const label = `${teams.find((t) => t.id === m.homeTeamId)?.shortName ?? 'Home'} v ${teams.find((t) => t.id === m.awayTeamId)?.shortName ?? 'Away'}`;
    const link = { pathname: '/match/[id]', params: { id: m.id } };

    // Who owes what: each side's captain (when there are officials to review), and the referee's report.
    const owed: { kind: 'captain' | 'referee'; teamId?: string; userId: string }[] = [];
    if (officialsToReview(m).length) {
      for (const teamId of [m.homeTeamId, m.awayTeamId]) {
        const userId = await captainUserFor(m.id, teamId);
        if (userId) owed.push({ kind: 'captain', teamId, userId });
      }
    }
    if (m.officials.refereeUserId) owed.push({ kind: 'referee', userId: m.officials.refereeUserId });

    for (const o of owed) {
      let due = await prisma.matchReviewDue.findUnique({ where: { matchId_kind_userId: { matchId: m.id, kind: o.kind, userId: o.userId } } });
      if (!due) {
        due = await prisma.matchReviewDue.create({ data: { id: newId('rev'), matchId: m.id, kind: o.kind, teamId: o.teamId ?? null, userId: o.userId, askedAt: now } });
        out.asked++;
        await notify(o.userId, o.kind === 'captain'
          ? { kind: 'official', title: `Review the officials for ${label}`, body: `As captain, rate the umpires${m.officials.refereeUserId ? ' and the match referee' : ''} within ${REVIEW_HOURS} hours. The league sees who has.`, link }
          : { kind: 'official', title: `File your match report for ${label}`, body: `Send the league your report (conduct, pitch, incidents) and rate the umpires within ${REVIEW_HOURS} hours.`, link });
      }
      if (due.doneAt) continue;
      const done = o.kind === 'captain' ? await captainReviewDone(m, o.userId) : !!(await prisma.refereeReport.findUnique({ where: { matchId: m.id }, select: { matchId: true } }));
      if (done) {
        await prisma.matchReviewDue.update({ where: { id: due.id }, data: { doneAt: now } });
        continue;
      }
      const hours = (now.getTime() - due.askedAt.getTime()) / 3_600_000;
      if (hours >= REVIEW_HOURS && !due.flaggedAt) {
        await prisma.matchReviewDue.update({ where: { id: due.id }, data: { flaggedAt: now } });
        out.flagged++;
        const team = o.teamId ? teams.find((t) => t.id === o.teamId)?.name : undefined;
        await notify(await orgAdminIds(orgId), { kind: 'official', title: o.kind === 'captain' ? `${team ?? 'A captain'} hasn’t reviewed the officials` : 'No match report from the referee', body: `${label}: ${REVIEW_HOURS} hours have passed. ${o.kind === 'captain' ? 'The captain hasn’t rated the officials.' : `${m.officials.refereeName ?? 'The referee'} hasn’t filed the match report.`}`, link });
        await notify(o.userId, { kind: 'official', title: o.kind === 'captain' ? 'Your review is overdue' : 'Your match report is overdue', body: `${label}: the league has been told. You can still send it.`, link });
      } else if (hours >= REMIND_HOURS && !due.remindedAt && !due.flaggedAt) {
        await prisma.matchReviewDue.update({ where: { id: due.id }, data: { remindedAt: now } });
        out.reminded++;
        await notify(o.userId, { kind: 'official', title: o.kind === 'captain' ? `Reminder: review the officials for ${label}` : `Reminder: your match report for ${label}`, body: `Due ${REVIEW_HOURS} hours after the match. After that the league is told.`, link });
      }
    }
  }
  return out;
}
