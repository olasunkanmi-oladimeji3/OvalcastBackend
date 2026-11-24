// Staff merge a duplicate club into the one to keep: every player, match, squad place, entry, transfer,
// team sheet, membership and story moves across, the club id inside stored data (match tosses,
// line-ups and results, competition groups, people's follows, honours) is rewritten, and the duplicate
// goes. Refused when the two clubs played each other or are in the same competition: that would put
// a club against itself.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, Prisma } from '~/db/client';
import { requireStaff } from '~/lib/auth';
import { clearAllCaches } from '~/lib/cache';
import { badRequest, conflict, notFound } from '~/lib/errors';
import { logStaff } from '~/lib/staffLog';

/** Data-blob columns that can hold a club id, by table: rewritten with the id replaced. */
const JSON_COLUMNS: Record<string, string[]> = {
  matches: ['toss', 'playing_xi', 'result', 'placeholders', 'winner_to', 'scores', 'leaders', 'decision'],
  competitions: ['stages', 'team_ids'],
  users: ['follows'],
  organisations: ['honours', 'season_moves'],
};

export async function clubMergeRoutes(app: FastifyInstance) {
  // What merging would move, for staff to check before they do it.
  app.get('/staff/clubs/merge-preview', async (req) => {
    requireStaff(req);
    const { keepId, mergeId } = z.object({ keepId: z.string(), mergeId: z.string() }).parse(req.query);
    const [keep, merge] = await Promise.all([prisma.team.findUnique({ where: { id: keepId } }), prisma.team.findUnique({ where: { id: mergeId } })]);
    if (!keep || !merge) throw notFound('Club');
    const [players, matches, entries, members] = await Promise.all([
      prisma.player.count({ where: { teamId: mergeId } }),
      prisma.match.count({ where: { OR: [{ homeTeamId: mergeId }, { awayTeamId: mergeId }] } }),
      prisma.entry.count({ where: { teamId: mergeId } }),
      prisma.membership.count({ where: { clubId: mergeId } }),
    ]);
    return { keep: { id: keep.id, name: keep.name, city: keep.city }, merge: { id: merge.id, name: merge.name, city: merge.city, adHoc: merge.adHoc }, moves: { players, matches, entries, members }, problem: await mergeProblem(keepId, mergeId) };
  });

  app.post('/staff/clubs/merge', async (req) => {
    const staff = requireStaff(req);
    const b = z.object({ keepId: z.string(), mergeId: z.string(), note: z.string().trim().min(3, 'Say why, for the log').max(200) }).parse(req.body);
    if (b.keepId === b.mergeId) throw badRequest('Pick two different clubs');
    const [keep, merge] = await Promise.all([prisma.team.findUnique({ where: { id: b.keepId } }), prisma.team.findUnique({ where: { id: b.mergeId } })]);
    if (!keep || !merge) throw notFound('Club');
    const problem = await mergeProblem(b.keepId, b.mergeId);
    if (problem) throw conflict(problem);
    const from = b.mergeId;
    const to = b.keepId;

    await prisma.$transaction(async (tx) => {
      await tx.player.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.match.updateMany({ where: { homeTeamId: from }, data: { homeTeamId: to } });
      await tx.match.updateMany({ where: { awayTeamId: from }, data: { awayTeamId: to } });
      await tx.match.updateMany({ where: { battingFirstTeamId: from }, data: { battingFirstTeamId: to } });
      await tx.registration.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.entry.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.deduction.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.fixtureRequest.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.marketListing.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.playerClaim.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.playerInvite.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.post.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.story.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.teamSheet.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.tossSession.updateMany({ where: { callerTeamId: from }, data: { callerTeamId: to } });
      await tx.tossSession.updateMany({ where: { wonByTeamId: from }, data: { wonByTeamId: to } });
      await tx.transfer.updateMany({ where: { fromTeamId: from }, data: { fromTeamId: to } });
      await tx.transfer.updateMany({ where: { toTeamId: from }, data: { toTeamId: to } });
      await tx.clashAllowance.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.matchReviewDue.updateMany({ where: { teamId: from }, data: { teamId: to } });
      await tx.seasonQyp.updateMany({ where: { mainTeamId: from }, data: { mainTeamId: to } });
      await tx.seasonQyp.updateMany({ where: { qypTeamId: from }, data: { qypTeamId: to } });
      await tx.team.updateMany({ where: { parentTeamId: from }, data: { parentTeamId: to } });
      // Club roles: anyone with the same role at both keeps one.
      for (const m of await tx.membership.findMany({ where: { clubId: from } })) {
        const dup = await tx.membership.findFirst({ where: { clubId: to, userId: m.userId, role: m.role } });
        if (dup) await tx.membership.delete({ where: { id: m.id } });
        else await tx.membership.update({ where: { id: m.id }, data: { clubId: to } });
      }
      // The YouTube channel: the kept club's own wins.
      const yt = await tx.youTubeKey.findUnique({ where: { ownerId: from } });
      if (yt) {
        if (await tx.youTubeKey.findUnique({ where: { ownerId: to } })) await tx.youTubeKey.delete({ where: { ownerId: from } });
        else await tx.youTubeKey.update({ where: { ownerId: from }, data: { ownerId: to } });
      }
      // The id inside stored data, as a whole quoted value or key only (ids are unique strings).
      for (const [table, columns] of Object.entries(JSON_COLUMNS)) {
        for (const col of columns) {
          await tx.$executeRaw(Prisma.sql`update ${Prisma.raw(`"${table}"`)} set ${Prisma.raw(`"${col}"`)} = replace(${Prisma.raw(`"${col}"`)}::text, ${`"${from}"`}, ${`"${to}"`})::jsonb where ${Prisma.raw(`"${col}"`)}::text like ${`%"${from}"%`}`);
        }
      }
      await tx.team.delete({ where: { id: from } });
    });
    clearAllCaches();
    await logStaff(staff, 'mergeClubs', 'team', to, `${merge.name} (${from}) into ${keep.name}: ${b.note}`);
    return { ok: true as const, keptId: to };
  });
}

/** Why two clubs can't be merged, or undefined when they can. */
async function mergeProblem(keepId: string, mergeId: string): Promise<string | undefined> {
  const met = await prisma.match.count({ where: { OR: [{ homeTeamId: keepId, awayTeamId: mergeId }, { homeTeamId: mergeId, awayTeamId: keepId }] } });
  if (met) return `They played each other ${met === 1 ? 'once' : `${met} times`}: merged, a club would be playing itself. Delete or reassign those matches first`;
  const keepEntries = new Set((await prisma.entry.findMany({ where: { teamId: keepId }, select: { competitionId: true } })).map((e) => e.competitionId));
  const both = (await prisma.entry.findMany({ where: { teamId: mergeId }, select: { competitionId: true } })).find((e) => keepEntries.has(e.competitionId));
  if (both) {
    const c = await prisma.competition.findUnique({ where: { id: both.competitionId }, select: { name: true, season: true } });
    return `Both are in ${c ? `${c.name} ${c.season}` : 'the same competition'}. Withdraw one from it first`;
  }
  return undefined;
}
