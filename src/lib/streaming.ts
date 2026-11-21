// Who may stream a match, and who is paid when it earns money.
//
// A match's organiser (a league admin for league matches; for a friendly, its creator or either
// club's admins) may stream it, and so may: streamers the organiser approved for that match (by
// invitation, or by approving their request), and the club's or league's Media list (standing
// streamers). The organiser sets the stream's money: pay per view or donations. The host share of
// each sale goes to the organiser who set it, except an approved streamer's agreed part, for sales
// made while they were streaming. The Media list streams for the organisation: no part.
import type { Match, MatchStreamer, User } from '@/api/types';
import { prisma } from '~/db/client';
import { isClubAdmin, isLeagueAdmin } from '~/lib/repo';
import { oneAtATime } from '~/lib/lock';

/** The organisation that runs a league match (none for a friendly). */
export async function orgOfMatch(m: Pick<Match, 'competitionId'>) {
  if (!m.competitionId) return undefined;
  return (await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } }))?.orgId;
}

/** Whoever runs the match: a league admin for league matches; for a friendly, its creator or either club's admins. */
export async function organisesMatch(user: User, m: Match) {
  if (m.competitionId) return isLeagueAdmin(user, await orgOfMatch(m));
  return m.createdBy === user.id || isClubAdmin(user, m.homeTeamId) || isClubAdmin(user, m.awayTeamId);
}

/** On the Media list of the league running the match, or of either club. */
export async function isMediaFor(user: User, m: Match) {
  const orgId = await orgOfMatch(m);
  return user.memberships.some((x) => x.role === 'media' && ((!!orgId && x.orgId === orgId) || x.clubId === m.homeTeamId || x.clubId === m.awayTeamId));
}

export const approvedStreamer = (m: Match, userId: string): MatchStreamer | undefined => m.officials.streamers?.find((s) => s.userId === userId);

/** May this person start (or carry on) the match's stream? */
export async function mayStream(user: User, m: Match) {
  return !!approvedStreamer(m, user.id) || (await organisesMatch(user, m)) || (await isMediaFor(user, m));
}

/**
 * The approved streamer owed part of a sale on this match, and their agreed part: whoever is
 * streaming now (or streamed last), when they were approved for it with a share and aren't the host.
 */
export async function streamerCut(m: Match, hostUserId: string): Promise<{ userId: string; share: number } | undefined> {
  // Ids start with the time, so the newest stream sorts last.
  const s = await prisma.stream.findFirst({ where: { matchId: m.id }, orderBy: { id: 'desc' }, select: { startedBy: true } });
  if (!s?.startedBy || s.startedBy === hostUserId) return undefined;
  const approved = approvedStreamer(m, s.startedBy);
  return approved && approved.share > 0 ? { userId: approved.userId, share: approved.share } : undefined;
}

/**
 * Rebuilds a match's earnings rows (pass_sales: one per person paid) from its active passes and its
 * donations, so a refund of passes never touches donation money and every part adds up. The host's
 * row carries the counts, gross and fees; an approved streamer's row carries only their part.
 */
export async function rebuildSales(matchId: string) {
  await oneAtATime(`sales:${matchId}`, async () => {
    const [passes, gifts] = await Promise.all([
      prisma.matchPass.findMany({ where: { matchId, status: 'active' }, select: { price: true, currency: true, fee: true, hostShare: true, hostUserId: true, streamerUserId: true, streamerAmount: true } }),
      prisma.donation.findMany({ where: { matchId }, select: { amount: true, currency: true, fee: true, hostShare: true, hostUserId: true, streamerUserId: true, streamerAmount: true } }),
    ]);
    const rows = new Map<string, { passes: number; donations: number; gross: number; fees: number; host: number; currency: string }>();
    const row = (userId: string, currency: string) => rows.get(userId) ?? rows.set(userId, { passes: 0, donations: 0, gross: 0, fees: 0, host: 0, currency }).get(userId)!;
    for (const p of passes) {
      const h = row(p.hostUserId, p.currency);
      h.passes += 1;
      h.gross += p.price;
      h.fees += p.fee ?? 0;
      h.host += (p.hostShare ?? 0) - p.streamerAmount;
      if (p.streamerUserId && p.streamerAmount) row(p.streamerUserId, p.currency).host += p.streamerAmount;
    }
    for (const d of gifts) {
      const h = row(d.hostUserId, d.currency);
      h.donations += 1;
      h.gross += d.amount;
      h.fees += d.fee;
      h.host += d.hostShare - d.streamerAmount;
      if (d.streamerUserId && d.streamerAmount) row(d.streamerUserId, d.currency).host += d.streamerAmount;
    }
    // Anyone no longer owed anything for this match keeps their row, at zero.
    await prisma.passSale.updateMany({ where: { matchId, hostUserId: { notIn: [...rows.keys()] } }, data: { passes: 0, donations: 0, gross: 0, fees: 0, host: 0 } });
    for (const [hostUserId, r] of rows) {
      await prisma.passSale.upsert({ where: { matchId_hostUserId: { matchId, hostUserId } }, create: { matchId, hostUserId, ...r }, update: r });
    }
  });
}
