// An organisation's season: every one of its leagues with the same season label, with the season's
// QYP rules and the organisation's QYP decisions. The shared eligibility rules (engine/eligibility)
// take this as a SeasonContext, so registration, team sheets, transfers and the marketplace all
// judge second clubs the same way.
import type { SeasonContext } from '@/engine';
import { prisma } from '~/db/client';

/** The season a league belongs to, or undefined when it has no organisation season (a league always does). */
export async function seasonOf(orgId: string, season: string): Promise<SeasonContext> {
  const [settings, leagues, decisions] = await Promise.all([
    prisma.orgSeason.findUnique({ where: { orgId_season: { orgId, season } } }),
    prisma.competition.findMany({ where: { orgId, season }, select: { id: true, startsOn: true } }),
    prisma.seasonQyp.findMany({ where: { orgId, season }, select: { playerId: true, status: true, mainTeamId: true } }),
  ]);
  const first = leagues.map((l) => l.startsOn.toISOString().slice(0, 10)).sort()[0] ?? new Date().toISOString().slice(0, 10);
  return {
    orgId,
    season,
    qyp: { enabled: settings?.qypEnabled ?? false, maxAge: settings?.qypMaxAge ?? 23 },
    startsOn: first,
    leagueIds: leagues.map((l) => l.id),
    decisions: decisions.map((d) => ({ playerId: d.playerId, status: d.status as 'pending' | 'approved' | 'declined', mainTeamId: d.mainTeamId })),
  };
}

/** Seasons for several leagues at once, keyed `orgId|season`. */
export async function seasonsFor(leagues: { orgId: string; season: string }[]) {
  const keys = [...new Set(leagues.map((l) => `${l.orgId}|${l.season}`))];
  const out = new Map<string, SeasonContext>();
  for (const k of keys) {
    const [orgId, season] = k.split('|');
    out.set(k, await seasonOf(orgId, season));
  }
  return out;
}
