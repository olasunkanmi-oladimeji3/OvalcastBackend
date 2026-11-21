// In-app news about a match for the people in it: a reminder the evening before and two hours
// before, and the result afterwards, told from each side (your team won, or lost) with the match's
// awards. Players in either squad, club staff and admins, the officials, and followers of the clubs
// or the league. Each person's alert settings are respected.

import type { Match } from '@/api/types';
import type { BallEvent, MatchSetup, MatchState } from '@/engine';
import { COUNTRY_LIST, matchAwards, type MatchAwards } from '@/engine';
import { prisma } from '~/db/client';
import { followerIds, notify } from '~/lib/repo';

type Topic = 'myMatches' | 'myClubs' | 'results';

/** Who is in a match, by side; officials; and followers. Account ids. */
export async function matchPeople(m: Match) {
  const sides = [m.homeTeamId, m.awayTeamId].filter(Boolean);
  const side = async (teamId: string) => {
    const regs = m.competitionId ? await prisma.registration.findMany({ where: { competitionId: m.competitionId, teamId, status: 'active' }, select: { playerId: true } }) : [];
    const squad = await prisma.player.findMany({ where: { OR: [{ teamId }, { id: { in: regs.map((r) => r.playerId) } }] }, select: { id: true, claimedByUserId: true } });
    const ids = squad.map((p) => p.id);
    const owners = await prisma.user.findMany({ where: { playerId: { in: ids } }, select: { id: true } });
    const admins = await prisma.membership.findMany({ where: { clubId: teamId, role: 'clubAdmin' }, select: { userId: true } });
    const team = await prisma.team.findUnique({ where: { id: teamId }, select: { staff: true } });
    const staff = ((team?.staff as { userId?: string }[] | null) ?? []).map((s) => s.userId).filter((u): u is string => !!u);
    return new Set([...owners.map((u) => u.id), ...squad.map((p) => p.claimedByUserId).filter((u): u is string => !!u), ...admins.map((a) => a.userId), ...staff]);
  };
  const [home, away] = await Promise.all(sides.map(side));
  const o = m.officials;
  const officials = new Set([o.scorerUserId, ...(o.umpireUserIds ?? []), ...(o.groundsmanUserIds ?? []), ...(o.streamers ?? []).map((s) => s.userId)].filter((u): u is string => !!u));
  const followers = new Set(await followerIds(sides, m.competitionId ? [m.competitionId] : []));
  return { home: home ?? new Set<string>(), away: away ?? new Set<string>(), officials, followers };
}

/** Keeps only the people who want this kind of news (alert settings default to on). */
async function wanting(ids: Set<string> | string[], topic: Topic) {
  const list = [...ids];
  if (!list.length) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, settings: true } });
  return rows.filter((u) => (u.settings as { alertTopics?: Record<string, boolean> } | null)?.alertTopics?.[topic] !== false).map((u) => u.id);
}

/** The time zone the match is played in: its league's country, else the creator's, else UTC. */
async function zoneOf(m: Match) {
  let country: string | undefined;
  if (m.competitionId) country = (await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { org: { select: { country: true } } } }))?.org.country;
  if (!country) {
    const team = await prisma.team.findUnique({ where: { id: m.homeTeamId }, select: { org: { select: { country: true } } } });
    country = team?.org?.country;
  }
  if (!country && m.createdBy) country = (await prisma.user.findUnique({ where: { id: m.createdBy }, select: { country: true } }))?.country ?? undefined;
  return COUNTRY_LIST.find((c) => c.name === country)?.timeZone ?? 'UTC';
}

const localParts = (d: Date, timeZone: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};
const timeIn = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).replace(' ', '').toLowerCase();
const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/**
 * Reminders, run every few minutes: the evening before (from 6pm local time the day before), and
 * two hours before the start. Each goes out once per match, to its squads, staff, officials and
 * followers.
 */
export async function sendMatchReminders(now = new Date()) {
  const soon = await prisma.match.findMany({
    where: { status: 'scheduled', startsAt: { gt: now, lte: new Date(now.getTime() + 36 * 3600_000) }, homeTeamId: { not: '' }, awayTeamId: { not: '' } },
    select: { id: true },
  });
  let sent = 0;
  for (const { id } of soon) {
    const row = await prisma.match.findUniqueOrThrow({ where: { id } });
    const { toMatch } = await import('~/lib/repo');
    const m = toMatch(row);
    const start = new Date(m.startsAt);
    const zone = await zoneOf(m);
    const already = row.remindersSent ?? [];
    const toGo = start.getTime() - now.getTime();
    let which: 'dayBefore' | 'twoHours' | undefined;
    if (!already.includes('twoHours') && toGo <= 2.25 * 3600_000) which = 'twoHours';
    else if (!already.includes('dayBefore') && !already.includes('twoHours') && toGo > 3 * 3600_000) {
      const here = localParts(now, zone);
      if (here.day === dayBefore(localParts(start, zone).day) && here.hour >= 18) which = 'dayBefore';
    }
    if (!which) continue;
    // Marked first, so a second runner (or a retry) never sends it again.
    const claimed = await prisma.match.updateMany({ where: { id, NOT: { remindersSent: { has: which } } }, data: { remindersSent: { push: which } } });
    if (!claimed.count) continue;
    const teams = new Map((await prisma.team.findMany({ where: { id: { in: [m.homeTeamId, m.awayTeamId] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const comp = m.competitionId ? (await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { name: true, season: true } })) : null;
    const vs = `${teams.get(m.homeTeamId) ?? 'Home'} v ${teams.get(m.awayTeamId) ?? 'Away'}`;
    const when = timeIn(start, zone);
    const where = `${m.venue || 'Venue to be confirmed'}${comp ? `. ${comp.name} ${comp.season}` : ''}`;
    const people = await matchPeople(m);
    const link = { pathname: '/match/[id]', params: { id: m.id } };
    const inIt = new Set([...people.home, ...people.away, ...people.officials]);
    const title = which === 'dayBefore' ? `Tomorrow, ${when}: ${vs}` : `Starts at ${when}: ${vs}`;
    const officialRole = (u: string) => (m.officials.scorerUserId === u ? 'scoring' : m.officials.umpireUserIds?.includes(u) ? 'umpiring' : m.officials.groundsmanUserIds?.includes(u) ? 'preparing the ground' : 'streaming');
    for (const u of await wanting(people.officials, 'myMatches')) {
      await notify(u, { kind: 'match', title, body: `You’re ${officialRole(u)}. ${where}.`, link });
    }
    const players = new Set([...people.home, ...people.away].filter((u) => !people.officials.has(u)));
    await notify(await wanting(players, 'myMatches'), { kind: 'match', title, body: `${where}.${which === 'twoHours' ? ' Good luck.' : ' Check the team sheet.'}`, link });
    await notify(await wanting(new Set([...people.followers].filter((u) => !inIt.has(u))), 'myClubs'), { kind: 'match', title, body: `${where}. Follow it ball by ball on Ovalcast.`, link });
    sent++;
  }
  return sent;
}

const nameIn = (setup: MatchSetup) => {
  const names = new Map(setup.teams.flatMap((t) => [...t.players, ...(t.substitutes ?? [])].map((p) => [p.id, p.name] as const)));
  return (id?: string) => (id ? names.get(id) ?? 'A player' : 'A player');
};

/** One line of a side's best performers: “Ade 54 (32), Bayo 3/20”. */
function bestLine(a: MatchAwards['byTeam'][string] | undefined, name: (id?: string) => string) {
  if (!a) return '';
  const bits = [
    a.bestBatter && a.bestBatter.runs > 0 ? `${name(a.bestBatter.playerId)} ${a.bestBatter.runs} (${a.bestBatter.balls})` : '',
    a.bestBowler && a.bestBowler.wickets > 0 ? `${name(a.bestBowler.playerId)} ${a.bestBowler.wickets}/${a.bestBowler.runs}` : '',
    a.bestFielder ? `${name(a.bestFielder.playerId)} ${a.bestFielder.catches + a.bestFielder.runOuts + a.bestFielder.stumpings} in the field` : '',
  ].filter(Boolean);
  return bits.join(', ');
}

/**
 * The result, told from each side: the winners hear they won, the losers that they lost, each with
 * their own best performers and the match's top performer. Followers and officials get it plainly.
 */
export async function tellResult(m: Match, setup: MatchSetup, state: MatchState, events: BallEvent[]) {
  if (!m.result) return;
  const awards = matchAwards(setup, state, events);
  const name = nameIn(setup);
  const teamName = (id: string) => setup.teams.find((t) => t.id === id)?.name ?? 'Your team';
  const pomId = m.playerOfMatchId ?? awards.playerOfMatch?.playerId;
  const pom = pomId ? `${m.playerOfMatchId ? 'Player of the match' : 'Top performer'}: ${name(pomId)}.` : '';
  const people = await matchPeople(m);
  const link = { pathname: '/match/[id]', params: { id: m.id } };
  const winner = m.result.outcome === 'win' ? m.result.winnerTeamId : undefined;
  const both = new Set([...people.home].filter((u) => people.away.has(u)));
  const told = new Set<string>();
  for (const [teamId, members] of [[m.homeTeamId, people.home], [m.awayTeamId, people.away]] as const) {
    const mine = [...members].filter((u) => !both.has(u));
    mine.forEach((u) => told.add(u));
    const best = bestLine(awards.byTeam[teamId], name);
    const other = teamId === m.homeTeamId ? m.awayTeamId : m.homeTeamId;
    const title = !winner ? `${teamName(teamId)} v ${teamName(other)}: ${m.result.outcome === 'tie' ? 'tied' : 'no result'}` : winner === teamId ? `${teamName(teamId)} won!` : `${teamName(teamId)} lost to ${teamName(other)}`;
    const body = [m.result.text + '.', best ? `Best for ${teamName(teamId)}: ${best}.` : '', pom].filter(Boolean).join(' ');
    await notify(await wanting(mine, 'myMatches'), { kind: 'result', title, body, link });
  }
  const plain = new Set([...people.officials, ...people.followers, ...both].filter((u) => !told.has(u)));
  await notify(await wanting(plain, 'results'), { kind: 'result', title: m.result.text, body: [`${teamName(m.homeTeamId)} v ${teamName(m.awayTeamId)}.`, pom].filter(Boolean).join(' '), link });
}
