// Is the picture getting out? The server asks the video service about every live stream, so any
// streaming app (the Ovalcast app, Larix, OBS) is treated the same: downtime is measured here, the
// streamer and organiser are told when the picture drops for 30 seconds, and viewers see that the
// picture is coming back while the score carries on.
import type * as P from '~/generated/prisma/client';
import { prisma } from '~/db/client';
import { clubAdminIds, notify, orgAdminIds } from '~/lib/repo';
import { liveInputConnected, videoConfigured } from '~/lib/video';

/** Seconds of no picture before the streamer and organiser are told. */
export const DOWN_ALERT_SECONDS = 30;
/** A gap between checks longer than this (a restart, a slow check) isn't counted either way. */
const MAX_GAP_SECONDS = 120;

/** Who hears about a dropped picture: whoever streams, and the match's organisers. */
async function peopleToTell(s: P.Stream) {
  const m = await prisma.match.findUnique({ where: { id: s.matchId }, select: { competitionId: true, createdBy: true, homeTeamId: true, awayTeamId: true } });
  if (!m) return s.startedBy ? [s.startedBy] : [];
  const orgId = m.competitionId ? (await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } }))?.orgId : undefined;
  const organisers = orgId ? await orgAdminIds(orgId) : [...(m.createdBy ? [m.createdBy] : []), ...(await clubAdminIds(m.homeTeamId)), ...(await clubAdminIds(m.awayTeamId))];
  return [...new Set([...(s.startedBy ? [s.startedBy] : []), ...organisers])];
}

/**
 * Records what the video service says now: adds the time since the last check to the live or down
 * total (nothing before the picture first arrives), changes the state, and tells people when it has
 * been down 30 seconds and when it comes back.
 */
export async function applyPicture(s: P.Stream, connected: boolean, now = new Date()) {
  const gap = s.checkedAt ? Math.round((now.getTime() - s.checkedAt.getTime()) / 1000) : 0;
  const counted = gap > 0 && gap <= MAX_GAP_SECONDS ? gap : 0;
  const was = s.picture;
  const next = connected ? 'live' : was === 'waiting' ? 'waiting' : 'down';
  const data: P.Prisma.StreamUpdateInput = { checkedAt: now, picture: next };
  if (was === 'live') data.liveSeconds = s.liveSeconds + counted;
  if (was === 'down') data.downSeconds = s.downSeconds + counted;
  if (next !== was) data.pictureAt = now;
  const downSince = next === 'down' ? (next === was ? s.pictureAt : now) : null;
  const shouldAlert = next === 'down' && !!downSince && now.getTime() - downSince.getTime() >= DOWN_ALERT_SECONDS * 1000 && (!s.downAlertedAt || s.downAlertedAt < downSince);
  if (shouldAlert) data.downAlertedAt = now;
  const saved = await prisma.stream.update({ where: { id: s.id }, data });
  if (shouldAlert) {
    await notify(await peopleToTell(s), { kind: 'match', title: 'Your stream’s picture has dropped', body: 'Nothing has reached viewers for 30 seconds. Check the phone’s signal and battery, or start streaming again: the address stays the same. A second approved streamer can take over from the match page.', link: { pathname: '/match/[id]', params: { id: s.matchId } } });
  } else if (was === 'down' && next === 'live' && s.downAlertedAt) {
    await notify(await peopleToTell(s), { kind: 'match', title: 'Your stream’s picture is back', body: 'Viewers can see the match again.', link: { pathname: '/match/[id]', params: { id: s.matchId } } });
  }
  return saved;
}

/** Checks every live stream with the video service. Runs every 20 seconds. */
export async function checkPictures(now = new Date()) {
  if (!videoConfigured()) return { checked: 0 };
  const live = await prisma.stream.findMany({ where: { status: 'live', liveInputId: { not: null } } });
  let checked = 0;
  for (const s of live) {
    try {
      await applyPicture(s, await liveInputConnected(s.liveInputId!), now);
      checked++;
    } catch {
      // The video service didn't answer: the next check tries again, and the gap isn't counted.
    }
  }
  return { checked };
}
