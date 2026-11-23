// Registering players into a league squad, with the league's rules checked for each one: a player
// already registered with another club here, a second club beyond what the league allows or over
// its age limit (QYP), or another league's rules. A player who fails is still registered, but held:
// they can't be picked until they choose their clubs or a league admin releases them with a reason.
//
// One person can have several player records (typed in by different clubs, then claimed by their
// account), so the checks run on the person, not the record.
import type { Competition } from '@/api/types';
import { registrationCheck } from '@/engine';
import { prisma } from '~/db/client';
import { newId } from '~/lib/ids';
import { notify, orgAdminIds, toCompetition, toRegistration } from '~/lib/repo';
import { seasonOf } from '~/lib/seasons';

type Tx = Pick<typeof prisma, 'registration' | 'player' | 'user' | 'competition' | 'team'>;

/** Every player record that belongs to the same person as each of `playerIds`, keyed by a person id. */
export async function peopleOf(playerIds: string[], db: Tx = prisma) {
  const [owners, claimed] = await Promise.all([
    db.user.findMany({ where: { playerId: { in: playerIds } }, select: { id: true, playerId: true } }),
    db.player.findMany({ where: { id: { in: playerIds }, claimedByUserId: { not: null } }, select: { id: true, claimedByUserId: true } }),
  ]);
  const userOf = new Map<string, string>();
  for (const o of owners) if (o.playerId) userOf.set(o.playerId, o.id);
  for (const c of claimed) if (c.claimedByUserId && !userOf.has(c.id)) userOf.set(c.id, c.claimedByUserId);
  const userIds = [...new Set(userOf.values())];
  const [users, claims] = await Promise.all([
    db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, playerId: true } }),
    db.player.findMany({ where: { claimedByUserId: { in: userIds } }, select: { id: true, claimedByUserId: true } }),
  ]);
  /** player record id -> person id (the account id, or the record itself when it has no account). */
  const person = new Map<string, string>(playerIds.map((p) => [p, userOf.get(p) ?? p]));
  for (const u of users) if (u.playerId) person.set(u.playerId, u.id);
  for (const c of claims) if (c.claimedByUserId) person.set(c.id, c.claimedByUserId);
  return person;
}

export type Held = { playerId: string; reason: string; canChoose: boolean };

/**
 * Registers `playerIds` for `teamId` in competition `c`, skipping anyone already registered there for
 * this club. Returns who was held and why. `approved`: false in leagues that approve squads, unless
 * a league admin is adding them.
 */
export async function registerPlayers(c: Competition, teamId: string, playerIds: string[], opts: { approved?: boolean; db?: Tx } = {}): Promise<Held[]> {
  const db = opts.db ?? prisma;
  if (!playerIds.length) return [];
  const person = await peopleOf(playerIds, db);
  const aliasIds = [...person.keys()];
  const regRows = await db.registration.findMany({ where: { playerId: { in: aliasIds } } });
  const regs = regRows.map((r) => ({ ...toRegistration(r), playerId: person.get(r.playerId) ?? r.playerId }));
  const comps = (await db.competition.findMany({ where: { id: { in: [...new Set([c.id, ...regs.map((r) => r.competitionId)])] } } })).map(toCompetition);
  const players = await db.player.findMany({ where: { id: { in: aliasIds } }, select: { id: true, dateOfBirth: true } });
  const born = new Map<string, string>();
  for (const p of players) if (p.dateOfBirth) born.set(person.get(p.id) ?? p.id, p.dateOfBirth.toISOString().slice(0, 10));
  // The date of birth given at sign-up, for anyone whose player records don't have one.
  const accounts = await db.user.findMany({ where: { id: { in: [...new Set(person.values())] }, dateOfBirth: { not: null } }, select: { id: true, dateOfBirth: true } });
  for (const a of accounts) if (!born.has(a.id)) born.set(a.id, a.dateOfBirth!.toISOString().slice(0, 10));
  // The league's season: second clubs across its leagues follow the season's QYP rules.
  const season = await seasonOf(c.orgId, c.season);
  const teamIds = [...new Set([teamId, ...regs.map((r) => r.teamId)])];
  const names = new Map((await db.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));

  const held: Held[] = [];
  const rows = [];
  const qypRequests: { playerId: string; mainTeamId: string; qypTeamId: string }[] = [];
  for (const playerId of [...new Set(playerIds)]) {
    const who = person.get(playerId) ?? playerId;
    // Already in this club's squad for this league (under any of their records): nothing to do.
    if (regs.some((r) => r.playerId === who && r.competitionId === c.id && r.teamId === teamId && r.status === 'active')) continue;
    const verdict = registrationCheck({ playerId: who, teamId, league: c, leagues: comps, regs, teamName: (id) => names.get(id) ?? 'another club', playerBirthDate: born.get(who), leagueStartsOn: c.startsOn, season });
    // A second club this season that qualifies as QYP waits for the organisation's approval.
    if (!verdict.ok && verdict.qypRequest) qypRequests.push({ playerId: who, ...verdict.qypRequest });
    const since = new Date();
    const row = { id: newId('reg'), competitionId: c.id, playerId, teamId, primary: verdict.ok ? verdict.primary : false, since, status: 'active', approved: opts.approved ?? !c.playerRules.squadApproval, heldReason: verdict.ok ? null : verdict.reason, overrideNote: null, overrideBy: null };
    rows.push(row);
    // Later players in the same squad see this one (the same person twice in one list).
    regs.push({ ...toRegistration(row), playerId: who });
    if (!verdict.ok) held.push({ playerId, reason: verdict.reason, canChoose: verdict.canChoose });
  }
  if (rows.length) await db.registration.createMany({ data: rows });
  if (qypRequests.length) await askForQyp(c, qypRequests);
  return held;
}

/** Tells the league's admins, and each held player with an account, what was held and why. */
export async function tellAboutHolds(c: Competition, teamId: string, held: Held[]) {
  if (!held.length) return;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
  const admins = await prisma.membership.findMany({ where: { orgId: c.orgId, role: { in: ['leagueAdmin', 'owner'] } }, select: { userId: true } });
  const link = { pathname: '/competition/[id]', params: { id: c.id } };
  await notify([...new Set(admins.map((a) => a.userId))], { kind: 'entry', title: `${held.length} ${held.length === 1 ? 'player' : 'players'} held in ${team?.name ?? 'a club'}'s squad`, body: `${c.name}. The league's player rules held them back. Release them with a reason, or the players choose their clubs.`, link });
  const users = await prisma.user.findMany({ where: { playerId: { in: held.map((h) => h.playerId) } }, select: { id: true, playerId: true } });
  for (const u of users) {
    const h = held.find((x) => x.playerId === u.playerId)!;
    await notify([u.id], { kind: 'entry', title: h.canChoose ? `Choose your club in ${c.name}` : `You're held in ${c.name}`, body: h.canChoose ? `${h.reason}. Choose your main club (and a second club, where the league allows it).` : `${h.reason}. The league can release you.`, link });
  }
}

/** QYP places waiting for the organisation: recorded once per player and season, and the admins told. */
async function askForQyp(c: Competition, requests: { playerId: string; mainTeamId: string; qypTeamId: string }[]) {
  let added = 0;
  for (const r of requests) {
    const existing = await prisma.seasonQyp.findUnique({ where: { orgId_season_playerId: { orgId: c.orgId, season: c.season, playerId: r.playerId } } });
    if (existing) continue;
    await prisma.seasonQyp.create({ data: { id: newId('qyp'), orgId: c.orgId, season: c.season, playerId: r.playerId, mainTeamId: r.mainTeamId, qypTeamId: r.qypTeamId, status: 'pending' } });
    added++;
  }
  if (added) await notify(await orgAdminIds(c.orgId), { kind: 'entry', title: `${added} QYP ${added === 1 ? 'request' : 'requests'} for the ${c.season} season`, body: 'Players asking to play for a second club in another of your leagues this season. Approve or decline each one on the season page.', link: { pathname: '/organisation/[id]', params: { id: c.orgId } } });
}

/**
 * After the organisation decides on a QYP player, their held registrations in the season are checked
 * again: approved ones are released, declined ones stay held with the new reason.
 */
export async function recheckSeasonHolds(orgId: string, season: string, personId: string) {
  const ctx = await seasonOf(orgId, season);
  const person = await peopleOf([personId]);
  const records = [...person.keys()];
  const claimed = await prisma.player.findMany({ where: { claimedByUserId: personId }, select: { id: true } });
  const owned = await prisma.user.findUnique({ where: { id: personId }, select: { playerId: true } }).catch(() => null);
  const ids = [...new Set([...records, ...claimed.map((p) => p.id), ...(owned?.playerId ? [owned.playerId] : [])])];
  const regRows = await prisma.registration.findMany({ where: { playerId: { in: ids } } });
  const regs = regRows.map((r) => ({ ...toRegistration(r), playerId: personId }));
  const comps = (await prisma.competition.findMany({ where: { id: { in: [...new Set(regs.map((r) => r.competitionId))] } } })).map(toCompetition);
  const dob = (await prisma.player.findFirst({ where: { id: { in: ids }, dateOfBirth: { not: null } }, select: { dateOfBirth: true } }))?.dateOfBirth ?? (await prisma.user.findUnique({ where: { id: personId }, select: { dateOfBirth: true } }).catch(() => null))?.dateOfBirth ?? null;
  for (const row of regRows.filter((r) => r.status === 'active' && r.heldReason && ctx.leagueIds.includes(r.competitionId))) {
    const league = comps.find((x) => x.id === row.competitionId);
    if (!league) continue;
    const others = regs.filter((r) => !(r.competitionId === row.competitionId && r.teamId === row.teamId));
    const verdict = registrationCheck({ playerId: personId, teamId: row.teamId, league, leagues: comps, regs: others, playerBirthDate: dob?.toISOString().slice(0, 10), leagueStartsOn: league.startsOn, season: ctx });
    await prisma.registration.update({ where: { id: row.id }, data: { heldReason: verdict.ok ? null : verdict.reason } });
  }
}
