// Leagues: standings, leaderboards, entries and fees, fixtures and knockouts,
// registrations, transfers and point deductions.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Competition, Leaderboards, Match, Payment, SeriesSummary, Standings, Transfer } from '@/api/types';
import { buildBracket, canTransfer, fitGroups, registrationCheck, roundRobin, standings, tableResult, transferOpen } from '@/engine';
import { entryShareFor } from '~/lib/shares';
import { prisma, toJson } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { ApiError, badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { oneAtATime } from '~/lib/lock';
import { registerPlayers, tellAboutHolds } from '~/lib/registration';
import { clubAdminIds, isClubAdmin, isLeagueAdmin, matchData, notify, toCompetition, toDeduction, toEntry, toMatch, toRegistration, toTransfer } from '~/lib/repo';
import { T20 } from '~/services/matches';
import { checkNewLeague, startCheckout } from '~/services/billing';
import { aggregate, replayedMatches } from '~/services/stats';

export async function comp(id: string): Promise<Competition> {
  const c = await prisma.competition.findUnique({ where: { id } });
  if (!c) throw notFound('Competition');
  return toCompetition(c);
}
const saveComp = (c: Competition) => prisma.competition.update({ where: { id: c.id }, data: { stages: toJson(c.stages), teamIds: toJson(c.teamIds), status: c.status } });

const activeDeductions = (competitionId: string) => prisma.deduction.findMany({ where: { competitionId, status: 'active' } });

async function groupTable(c: Competition, groupId: string, teamIds: string[]) {
  // Abandoned and no-result matches count too: a point each, nothing towards net run rate.
  const rows = (await prisma.match.findMany({ where: { groupId, status: { in: ['completed', 'abandoned'] } } })).map(toMatch);
  const results = rows.map((m) => tableResult(m, c.conditions.oversPerInnings * c.conditions.ballsPerOver, c.conditions.ballsPerOver)).filter((r): r is NonNullable<typeof r> => !!r);
  return standings(teamIds, results, c.points, c.tieBreakers, await activeDeductions(c.id));
}

/** Who won a finished competition: the final's winner, or the top of the table. */
async function championOf(c: Competition, played: Match[]): Promise<string | undefined> {
  const ko = c.stages.find((s) => s.kind === 'knockout');
  if (ko) {
    // The final is the knockout match nobody goes on from.
    const final = played.find((m) => m.stageId === ko.id && !m.winnerTo);
    if (final?.result?.winnerTeamId) return final.result.winnerTeamId;
  }
  const g = c.stages[0]?.groups[0];
  if (!g || c.stages[0].kind === 'knockout') return undefined;
  return (await groupTable(c, g.id, g.teamIds))[0]?.teamId;
}

/** Accepting a club: put it in the smallest group of the first stage and register its squad, with the league's player rules checked for each player. */
export async function enter(c: Competition, teamId: string) {
  if (c.teamIds.includes(teamId)) return;
  c.teamIds.push(teamId);
  const groups = c.stages[0].groups;
  groups.reduce((a, b) => (b.teamIds.length < a.teamIds.length ? b : a)).teamIds.push(teamId);
  await saveComp(c);
  const squad = await prisma.player.findMany({ where: { teamId, guest: false }, select: { id: true } });
  await tellAboutHolds(c, teamId, await registerPlayers(c, teamId, squad.map((p) => p.id)));
}

async function insertBracket(c: Competition, seeds: string[], stageId: string, groupId: string, start: Date) {
  const rounds = buildBracket(seeds);
  const ids = rounds.map((r) => r.map(() => newId('m')));
  const teamRows = seeds.length ? await prisma.team.findMany({ where: { id: { in: seeds } } }) : [];
  const out: Match[] = [];
  rounds.forEach((round, ri) =>
    round.forEach((b, si) => {
      if (b.bye) return;
      const when = new Date(start.getTime() + ri * 7 * 86_400_000);
      when.setHours(10 + (si % 2) * 4, 0, 0, 0);
      out.push({
        id: ids[ri][si], competitionId: c.id, stageId, groupId, homeTeamId: b.home ?? '', awayTeamId: b.away ?? '',
        venue: teamRows.find((t) => t.id === b.home)?.homeGround || 'To be confirmed', startsAt: when.toISOString(), status: 'scheduled', officials: { umpires: [] }, scores: [], locked: false,
        round: round.length > 1 ? `${b.roundName} ${si + 1}` : b.roundName, placeholders: { home: b.homeLabel, away: b.awayLabel },
        winnerTo: b.next && !rounds[b.next.round - 1][b.next.slot].bye ? { matchId: ids[b.next.round - 1][b.next.slot], side: b.next.side } : undefined,
      });
    }),
  );
  if (out.length) await prisma.match.createMany({ data: out.map((m) => ({ id: m.id, ...matchData(m) })) });
  return out;
}

const playerRulesSchema = z.object({
  multiClub: z.object({ allowed: z.boolean(), maxClubs: z.number().int().min(1).max(3), maxAge: z.number().int().min(10).max(40).optional() }),
  otherLeagues: z.enum(['allowed', 'notSameOrganisation', 'notAllowed']),
  guestPlayersPerXI: z.number().int().min(0).max(3),
  minMatchesForKnockouts: z.number().int().min(0).max(10),
  squadApproval: z.boolean().optional(),
  transfers: z.object({ windows: z.array(z.object({ name: z.string(), opensOn: z.string(), closesOn: z.string() })), maxPerPlayer: z.number().int().min(1).max(5) }).nullable(),
});

export async function competitionRoutes(app: FastifyInstance) {
  app.get('/competitions', async (req) => {
    const q = z.object({ orgId: z.string().optional(), status: z.enum(['entries', 'inProgress', 'completed']).optional(), seriesId: z.string().optional() }).parse(req.query);
    return (await prisma.competition.findMany({ where: { ...(q.orgId ? { orgId: q.orgId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.seriesId ? { seriesId: q.seriesId } : {}) }, orderBy: { startsOn: 'asc' } })).map(toCompetition);
  });

  // Year by year: each of an organisation's tournaments with its editions, oldest first, and how
  // each edition compares with the one before (clubs, matches played, runs scored, the champion).
  app.get<{ Params: { id: string } }>('/organisations/:id/series', async (req): Promise<SeriesSummary[]> => {
    const comps = (await prisma.competition.findMany({ where: { orgId: req.params.id }, orderBy: { startsOn: 'asc' } })).map(toCompetition);
    const matches = await prisma.match.findMany({ where: { competitionId: { in: comps.map((c) => c.id) }, status: 'completed' } });
    const bySeries = new Map<string, Competition[]>();
    for (const c of comps) bySeries.set(c.seriesId ?? c.id, [...(bySeries.get(c.seriesId ?? c.id) ?? []), c]);
    const out: SeriesSummary[] = [];
    for (const [seriesId, editions] of bySeries) {
      const rows: SeriesSummary['editions'] = [];
      for (const c of editions) {
        const played = matches.filter((m) => m.competitionId === c.id).map(toMatch);
        const runs = played.reduce((s, m) => s + m.scores.reduce((t, i) => t + i.runs, 0), 0);
        const row = { competitionId: c.id, season: c.season, status: c.status, teams: c.teamIds.length, matchesPlayed: played.length, runs, champion: c.status === 'completed' ? await championOf(c, played) : undefined };
        const prev = rows.at(-1);
        rows.push({ ...row, change: prev ? { teams: row.teams - prev.teams, matchesPlayed: row.matchesPlayed - prev.matchesPlayed, runs: row.runs - prev.runs } : undefined });
      }
      out.push({ seriesId, name: editions.at(-1)!.name, editions: rows });
    }
    // Tournaments with the most editions first, then the newest.
    return out.sort((a, b) => b.editions.length - a.editions.length || (b.editions.at(-1)!.season > a.editions.at(-1)!.season ? 1 : -1));
  });

  app.get<{ Params: { id: string } }>('/competitions/:id', async (req) => comp(req.params.id));

  app.get<{ Params: { id: string } }>('/competitions/:id/standings', async (req): Promise<Standings> => {
    const c = await comp(req.params.id);
    const { stageId } = z.object({ stageId: z.string().optional() }).parse(req.query);
    const stage = c.stages.find((s) => s.id === stageId) ?? c.stages[0];
    return { competitionId: c.id, stageId: stage.id, groups: await Promise.all(stage.groups.map(async (g) => ({ groupId: g.id, name: g.name, rows: await groupTable(c, g.id, g.teamIds) }))) };
  });

  app.get<{ Params: { id: string } }>('/competitions/:id/leaderboards', async (req): Promise<Leaderboards> => {
    const c = await comp(req.params.id);
    const figs = aggregate(await replayedMatches({ competitionId: c.id }));
    const regs = await prisma.registration.findMany({ where: { competitionId: c.id } });
    const teamOf = (pid: string) => regs.find((r) => r.playerId === pid && r.status === 'active')?.teamId ?? regs.find((r) => r.playerId === pid)?.teamId ?? '';
    const list = [...figs].filter(([pid]) => teamOf(pid));
    type F = (typeof list)[0][1];
    const top = (value: (f: F) => number, detail: (f: F) => string, keep: (f: F) => boolean = () => true, asc = false) =>
      list.filter(([, f]) => keep(f)).sort((a, b) => (asc ? value(a[1]) - value(b[1]) : value(b[1]) - value(a[1]))).slice(0, 10).map(([pid, f]) => ({ playerId: pid, teamId: teamOf(pid), value: Math.round(value(f) * 100) / 100, detail: detail(f) }));
    return {
      runs: top((f) => f.runs, (f) => `${f.balls} balls`, (f) => f.runs > 0),
      wickets: top((f) => f.wickets, (f) => `${f.runsConceded} runs conceded`, (f) => f.ballsBowled > 0),
      sixes: top((f) => f.sixes, (f) => `${f.runs} runs`, (f) => f.sixes > 0),
      strikeRate: top((f) => (f.runs / f.balls) * 100, (f) => `${f.runs} off ${f.balls}`, (f) => f.balls >= 30),
      economy: top((f) => (f.runsConceded / f.ballsBowled) * 6, (f) => `${Math.floor(f.ballsBowled / 6)} overs`, (f) => f.ballsBowled >= 36, true),
    };
  });

  app.post('/competitions', async (req) => {
    const user = requireUser(req);
    const b = z
      .object({
        orgId: z.string(), category: z.enum(['league', 'cup', 'festival', 'representative', 'schools', 'corporate']).default('league'), tier: z.number().int().min(1).max(9).optional(), rainRule: z.enum(['arr', 'mpo']).default('arr'), name: z.string().trim().min(1, 'Give it a name'), season: z.string().trim().min(1), format: z.enum(['T20', 'T10', '50 overs', 'The Hundred', 'Custom']), ballType: z.enum(['leather', 'tennis']),
        oversPerInnings: z.number().int().min(5).max(50), structure: z.enum(['league', 'groupsThenKnockout', 'knockout']), doubleRound: z.boolean(), groups: z.number().int().min(1).max(8), qualifyPerGroup: z.number().int().min(1).max(4),
        // The next edition of an earlier tournament of this organisation, so the years link up.
        continues: z.string().optional(),
        points: z.object({ win: z.number().int(), tie: z.number().int(), noResult: z.number().int(), loss: z.number().int() }), entryPolicy: z.enum(['open', 'inviteOnly']), entryFee: z.number().int().min(0), maxTeams: z.number().int().min(2).max(64), startsOn: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Give the start date').transform((v) => new Date(v)), playerRules: playerRulesSchema,
      })
      .parse(req.body);
    if (!isLeagueAdmin(user, b.orgId)) throw forbidden('Only a league admin can create competitions');
    await checkNewLeague(b.orgId, b.maxTeams);
    const id = newId('comp');
    let seriesId = id;
    if (b.continues) {
      const earlier = await prisma.competition.findUnique({ where: { id: b.continues }, select: { orgId: true, seriesId: true } });
      if (!earlier || earlier.orgId !== b.orgId) throw badRequest('Pick an earlier tournament of this organisation');
      seriesId = earlier.seriesId;
    }
    const groupCount = b.structure === 'groupsThenKnockout' ? Math.max(2, b.groups) : 1;
    const letters = 'ABCDEFGH';
    const stages: Competition['stages'] =
      b.structure === 'knockout'
        ? [{ id: `${id}_ko`, name: 'Knockout', kind: 'knockout', groups: [{ id: `${id}_all`, name: 'Draw', teamIds: [] }] }]
        : [
            {
              id: `${id}_s1`, name: b.structure === 'league' ? 'League' : 'Group stage', kind: 'roundRobin', doubleRound: b.doubleRound,
              groups: Array.from({ length: groupCount }, (_, i) => ({ id: `${id}_g${i}`, name: groupCount === 1 ? 'All teams' : `Group ${letters[i]}`, teamIds: [] })),
              qualify: b.structure === 'groupsThenKnockout' ? { topPerGroup: b.qualifyPerGroup, toStageId: `${id}_s2`, carryForward: 'fresh' } : undefined,
            },
            ...(b.structure === 'groupsThenKnockout' ? [{ id: `${id}_s2`, name: 'Knockouts', kind: 'knockout' as const, groups: [{ id: `${id}_ko`, name: 'Knockouts', teamIds: [] as string[] }] }] : []),
          ];
    const overs = b.oversPerInnings;
    await prisma.competition.create({
      data: {
        id, orgId: b.orgId, seriesId, category: b.category, tier: b.tier ?? null, rainRule: b.rainRule, name: b.name, season: b.season, division: b.name, format: b.format, ballType: b.ballType,
        conditions: toJson({ ...T20, oversPerInnings: overs, maxOversPerBowler: Math.max(1, Math.ceil(overs / 5)), powerplayOvers: Math.max(1, Math.round(overs * 0.3)), ballsPerOver: b.format === 'The Hundred' ? 5 : 6 }),
        points: toJson(b.points), tieBreakers: toJson(['wins', 'nrr', 'headToHead']), stages: toJson(stages), teamIds: toJson([]), status: 'entries', entryPolicy: b.entryPolicy, entryFee: b.entryFee, maxTeams: b.maxTeams, startsOn: b.startsOn, playerRules: toJson(b.playerRules),
        seasonRules: toJson([b.structure === 'league' ? `Every team plays every other ${b.doubleRound ? 'twice, home and away' : 'once'}` : b.structure === 'knockout' ? 'Straight knockout, lose and you are out' : `Top ${b.qualifyPerGroup} from each group go to the knockouts`]),
      },
    });
    return comp(id);
  });

  // ----------------------------------------------------------------- entries
  app.get('/entries', async (req) => {
    const q = z.object({ competitionId: z.string().optional(), teamId: z.string().optional() }).parse(req.query);
    if (!q.competitionId && !q.teamId) throw badRequest('Give a competitionId or a teamId');
    return (await prisma.entry.findMany({ where: q.competitionId ? { competitionId: q.competitionId } : { teamId: q.teamId }, orderBy: { createdAt: 'desc' } })).map(toEntry);
  });

  const openEntry = (competitionId: string, teamId: string) => prisma.entry.findFirst({ where: { competitionId, teamId, status: { in: ['pending', 'accepted'] } } });

  app.post<{ Params: { id: string } }>('/competitions/:id/invites', async (req) => {
    const user = requireUser(req);
    const { teamId, message } = z.object({ teamId: z.string(), message: z.string().optional() }).parse(req.body);
    const c = await comp(req.params.id);
    if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can invite clubs');
    if (c.status !== 'entries') throw conflict('Entries are closed for this league');
    if (await openEntry(c.id, teamId)) throw conflict('This club is already invited or entered');
    const e = await prisma.entry.create({ data: { id: newId('entry'), competitionId: c.id, teamId, kind: 'invite', status: 'pending', message: message ?? null } });
    await notify(await clubAdminIds(teamId), { kind: 'invite', title: `${c.name} invited your club`, body: message ?? 'Accept or decline for your club.', link: { pathname: '/team/[id]', params: { id: teamId, tab: 'leagues' } } });
    return toEntry(e);
  });

  app.post<{ Params: { id: string } }>('/competitions/:id/requests', async (req) => {
    const user = requireUser(req);
    const { teamId, message } = z.object({ teamId: z.string(), message: z.string().optional() }).parse(req.body);
    const c = await comp(req.params.id);
    if (!isClubAdmin(user, teamId)) throw forbidden('Only a club admin can ask to join a league');
    if (c.status !== 'entries') throw conflict('Entries are closed for this league');
    if (c.entryPolicy === 'inviteOnly') throw conflict('This league is invite only');
    if (c.teamIds.length >= c.maxTeams) throw conflict('This league is full');
    if (await openEntry(c.id, teamId)) throw conflict('Your club has already asked or been invited');
    return toEntry(await prisma.entry.create({ data: { id: newId('entry'), competitionId: c.id, teamId, kind: 'request', status: 'pending', message: message ?? null } }));
  });

  app.post<{ Params: { id: string } }>('/entries/:id/respond', async (req) => {
    const user = requireUser(req);
    const { response } = z.object({ response: z.enum(['accept', 'decline', 'withdraw']) }).parse(req.body);
    const e = await prisma.entry.findUnique({ where: { id: req.params.id } });
    if (!e) throw notFound('Entry');
    if (e.status !== 'pending') throw conflict('This has already been answered');
    const c = await comp(e.competitionId);
    // The side that did not start it answers; the side that did may withdraw.
    const sender = e.kind === 'invite' ? isLeagueAdmin(user, c.orgId) : isClubAdmin(user, e.teamId);
    const receiver = e.kind === 'invite' ? isClubAdmin(user, e.teamId) : isLeagueAdmin(user, c.orgId);
    if (response === 'withdraw' ? !sender : !receiver) throw forbidden('You cannot answer this');
    const status = response === 'accept' ? 'accepted' : response === 'decline' ? 'declined' : 'withdrawn';
    // Changes to one league's clubs go one at a time: two clubs accepted together both get in, and
    // the last place can't be given twice. The league and the entry are read again inside.
    return oneAtATime(`league:${c.id}`, async () => {
      const now = await prisma.entry.findUniqueOrThrow({ where: { id: e.id } });
      if (now.status !== 'pending') throw conflict('This has already been answered');
      const fresh = await comp(c.id);
      if (status === 'accepted' && fresh.teamIds.length >= fresh.maxTeams && !fresh.teamIds.includes(e.teamId)) throw conflict('This league is full');
      const saved = await prisma.entry.update({ where: { id: e.id }, data: { status, respondedAt: new Date() } });
      if (status === 'accepted') await enter(fresh, e.teamId);
      return toEntry(saved);
    });
  });

  app.post<{ Params: { id: string } }>('/entries/:id/pay', async (req) => {
    const user = requireUser(req);
    const { method } = z.object({ method: z.enum(['card', 'bankTransfer', 'ussd', 'mobileMoney']) }).parse(req.body);
    const e = await prisma.entry.findUnique({ where: { id: req.params.id } });
    if (!e) throw notFound('Entry');
    if (!isClubAdmin(user, e.teamId)) throw forbidden('Only the club admin can pay the entry fee');
    if (e.status !== 'accepted') throw conflict('Pay once the league has accepted your club');
    if ((e.payment as { status?: string } | null)?.status === 'paid') throw conflict('Already paid');
    const c = await comp(e.competitionId);
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: c.orgId }, include: { payoutAccount: true } });
    if (!org.payoutAccount) throw conflict(`${org.name} has not added a payout account yet, so the fee cannot be paid online. Pay the league in cash and they will mark it paid.`);
    // A split payment: Flutterwave settles it to the league's subaccount, less Ovalcast's entry share
    // (the organisation's own rate, or the global one), which the payment records.
    // Development completes it at once; production redirects to Flutterwave and the webhook completes it.
    const serviceRate = await entryShareFor(org.id);
    const r = await startCheckout({ kind: 'entry', user, refId: e.id, amount: c.entryFee, currency: org.currency, method, title: `${c.name} entry fee`, meta: { serviceRate }, subaccount: { id: org.payoutAccount.subaccountCode, serviceFee: Math.round(c.entryFee * serviceRate) } });
    return r;
  });

  app.post<{ Params: { id: string } }>('/entries/:id/mark-paid', async (req) => {
    const user = requireUser(req);
    const e = await prisma.entry.findUnique({ where: { id: req.params.id } });
    if (!e) throw notFound('Entry');
    const c = await comp(e.competitionId);
    if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can mark cash as paid');
    // Never over a fee already paid: that record is the league's proof of an online payment.
    if ((e.payment as { status?: string } | null)?.status === 'paid') throw conflict('This club has already paid');
    if (e.status !== 'accepted') throw conflict('Mark a fee paid once the club is in the league');
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: c.orgId } });
    const payment: Payment = { id: newId('pay'), entryId: e.id, amount: c.entryFee, currency: org.currency as Payment['currency'], method: 'cash', provider: 'cash', reference: `CASH-${Date.now().toString(36).toUpperCase()}`, status: 'paid', at: new Date().toISOString() };
    return toEntry(await prisma.entry.update({ where: { id: e.id }, data: { payment: toJson(payment) } }));
  });

  // ------------------------------------------------------ fixtures, knockouts
  app.post<{ Params: { id: string } }>('/competitions/:id/fixtures', async (req) => {
    const user = requireUser(req);
    // A double click, or a club accepted meanwhile: one change to this league at a time.
    return oneAtATime(`league:${req.params.id}`, async () => {
      const c = await comp(req.params.id);
      if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can create fixtures');
      if (c.teamIds.length < 2) throw conflict('A league needs at least two clubs');
      if (c.status !== 'entries') throw conflict('The fixtures are already built');
      const start = new Date(c.startsOn);
      const stage = c.stages[0];
      const teamRows = await prisma.team.findMany({ where: { id: { in: c.teamIds } } });
      const created: Match[] = [];
      if (stage.kind === 'knockout') created.push(...(await insertBracket(c, [...c.teamIds], stage.id, stage.groups[0].id, start)));
      else {
        // Groups are fitted to the teams that came: two teams never end up alone in two groups.
        fitGroups(stage, [...c.teamIds]);
        for (const g of stage.groups) {
          if (g.teamIds.length < 2) continue;
          roundRobin(g.teamIds, !!stage.doubleRound).forEach((round, ri) =>
            round.forEach(([home, away], mi) => {
              const when = new Date(start.getTime() + ri * 7 * 86_400_000);
              when.setHours(10 + (mi % 2) * 4, 0, 0, 0);
              created.push({ id: newId('m'), competitionId: c.id, stageId: stage.id, groupId: g.id, homeTeamId: home, awayTeamId: away, venue: teamRows.find((t) => t.id === home)?.homeGround || 'To be confirmed', startsAt: when.toISOString(), status: 'scheduled', officials: { umpires: [] }, scores: [], locked: false });
            }),
          );
        }
        if (created.length) await prisma.match.createMany({ data: created.map((m) => ({ id: m.id, ...matchData(m) })) });
      }
      c.status = 'inProgress';
      await saveComp(c);
      await prisma.entry.updateMany({ where: { competitionId: c.id, status: 'pending' }, data: { status: 'declined', respondedAt: new Date() } });
      return created;
    });
  });

  app.post<{ Params: { id: string } }>('/competitions/:id/knockouts', async (req) => {
    const user = requireUser(req);
    // A double click, or a club accepted meanwhile: one change to this league at a time.
    return oneAtATime(`league:${req.params.id}`, async () => {
      const c = await comp(req.params.id);
      if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can build the knockouts');
      const groupStage = c.stages[0];
      const ko = c.stages.find((s) => s.kind === 'knockout' && s.id !== groupStage.id);
      if (!ko || !groupStage.qualify) throw conflict('This league has no knockout stage');
      if (await prisma.match.count({ where: { stageId: ko.id } })) throw conflict('The knockouts are already drawn');
      const left = await prisma.match.count({ where: { stageId: groupStage.id, status: { notIn: ['completed', 'abandoned'] } } });
      if (left) throw conflict(`${left} group match${left === 1 ? ' is' : 'es are'} still to play`);
      // Group winners first, then runners-up, so winners meet runners-up from another group.
      const tables = await Promise.all(groupStage.groups.map(async (g) => (await groupTable(c, g.id, g.teamIds)).map((r) => r.teamId)));
      const seeds: string[] = [];
      for (let pos = 0; pos < groupStage.qualify.topPerGroup; pos++) for (const t of tables) if (t[pos]) seeds.push(t[pos]);
      const last = await prisma.match.findFirst({ where: { competitionId: c.id }, orderBy: { startsAt: 'desc' }, select: { startsAt: true } });
      const created = await insertBracket(c, seeds, ko.id, ko.groups[0].id, new Date((last?.startsAt ?? new Date(c.startsOn)).getTime() + 7 * 86_400_000));
      ko.groups[0].teamIds = seeds;
      await saveComp(c);
      return created;
    });
  });

  // -------------------------------------------------- registrations, transfers
  app.get('/registrations', async (req) => {
    const q = z.object({ competitionId: z.string().optional(), playerId: z.string().optional(), teamId: z.string().optional() }).parse(req.query);
    return (await prisma.registration.findMany({ where: { ...(q.competitionId ? { competitionId: q.competitionId } : {}), ...(q.playerId ? { playerId: q.playerId } : {}), ...(q.teamId ? { teamId: q.teamId } : {}) } })).map(toRegistration);
  });

  app.get('/transfers', async (req) => {
    const q = z.object({ competitionId: z.string().optional(), playerId: z.string().optional() }).parse(req.query);
    return (await prisma.transfer.findMany({ where: { ...(q.competitionId ? { competitionId: q.competitionId } : {}), ...(q.playerId ? { playerId: q.playerId } : {}) }, orderBy: { createdAt: 'desc' } })).map(toTransfer);
  });

  const transferCheck = async (input: { competitionId: string; playerId: string; fromTeamId: string; toTeamId: string; kind: 'move' | 'dual' }, excludeId?: string) => {
    const c = await comp(input.competitionId);
    const [regs, trs] = await Promise.all([prisma.registration.findMany({ where: { competitionId: c.id } }), prisma.transfer.findMany({ where: { competitionId: c.id } })]);
    const regRefs = regs.map(toRegistration);
    // The date of birth decides an age-limited second club; it's read here and never sent out.
    const born = (await prisma.player.findUnique({ where: { id: input.playerId }, select: { dateOfBirth: true } }))?.dateOfBirth;
    return { c, regs: regRefs, verdict: canTransfer({ ...input, league: c, regs: regRefs, transfers: trs.filter((t) => t.id !== excludeId).map(toTransfer), excludePending: !!excludeId, playerBirthDate: born ? born.toISOString().slice(0, 10) : undefined, leagueStartsOn: new Date(c.startsOn).toISOString() }) };
  };

  /** The user who is this player on Ovalcast, if they've joined. */
  const playerUser = async (playerId: string) => (await prisma.user.findFirst({ where: { playerId }, select: { id: true } }))?.id;
  const teamName = async (id: string) => (await prisma.team.findUnique({ where: { id }, select: { name: true } }))?.name ?? 'A club';
  const transfersLink = (id: string) => ({ pathname: '/competition/[id]', params: { id, tab: 'transfers' } });
  /** Under 18 without a guardian's agreement on record: the player can't agree on their own. */
  const needsGuardian = async (playerId: string) => {
    const p = await prisma.player.findUnique({ where: { id: playerId }, select: { minor: true, guardianConsent: true } });
    return !!p?.minor && !p.guardianConsent;
  };
  const GUARDIAN = 'They’re under 18, so a guardian has to agree too. Their club records it by ticking Guardian agreed in the squad, then they can agree.';

  // A club asks for a player (the player agrees next), or a player asks to join a club (that club accepts next).
  app.post('/transfers', async (req) => {
    const user = requireUser(req);
    const b = z.object({ competitionId: z.string(), playerId: z.string(), fromTeamId: z.string(), toTeamId: z.string(), kind: z.enum(['move', 'dual']), note: z.string().trim().max(500).optional() }).parse(req.body);
    const asClub = isClubAdmin(user, b.toTeamId);
    const asPlayer = !!user.playerId && user.playerId === b.playerId;
    if (!asClub && !asPlayer) throw forbidden('Only the player, or the admin of the club that wants them, can ask');
    const { c, verdict } = await transferCheck(b);
    if (!c.teamIds.includes(b.toTeamId)) throw conflict(asClub ? 'Your club is not in this league' : 'That club is not in this league');
    if (!verdict.ok) throw conflict(verdict.reason);
    if (asPlayer && (await needsGuardian(b.playerId))) throw conflict(GUARDIAN.replace('They’re', 'You’re').replace('then they can agree', 'then you can ask'));
    const at = new Date().toISOString();
    // The player agreeing and the club accepting are the first two steps; someone who is both does both at once.
    const history: Transfer['history'] = asPlayer
      ? [{ status: 'awaitingNewClub', at, by: 'player' }, ...(asClub ? [{ status: 'awaitingClub' as const, at, by: 'requestingClub' as const }] : [])]
      : [{ status: 'awaitingPlayer', at, by: 'requestingClub' }];
    const status = history.at(-1)!.status;
    const t = await prisma.transfer.create({ data: { id: newId('tr'), ...b, note: b.note ?? null, status, history: toJson(history) } });
    const what = b.kind === 'dual' ? 'as a second club' : 'on a move';
    if (status === 'awaitingPlayer') {
      const uid = await playerUser(b.playerId);
      if (uid) await notify([uid], { kind: 'transfer', title: `${await teamName(b.toTeamId)} wants you ${what}`, body: `${c.name}. Agree or decline.`, link: transfersLink(c.id) });
    } else if (status === 'awaitingNewClub') {
      await notify(await clubAdminIds(b.toTeamId), { kind: 'transfer', title: `${user.name} wants to join your club ${what}`, body: `${c.name}. Accept or turn down.`, link: transfersLink(c.id) });
    } else {
      await notify(await clubAdminIds(b.fromTeamId), { kind: 'transfer', title: 'A club wants one of your players', body: `${c.name}. Release or turn down.`, link: transfersLink(c.id) });
    }
    return toTransfer(t);
  });

  app.post<{ Params: { id: string } }>('/transfers/:id/respond', async (req) => {
    const user = requireUser(req);
    const { response, note } = z.object({ response: z.enum(['approve', 'reject', 'withdraw', 'dispute']), note: z.string().trim().max(500).optional() }).parse(req.body);
    const row = await prisma.transfer.findUnique({ where: { id: req.params.id } });
    if (!row) throw notFound('Transfer');
    const t = toTransfer(row);
    const c = await comp(t.competitionId);
    const at = new Date().toISOString();
    const isPlayer = !!user.playerId && user.playerId === t.playerId;
    const requesting = isClubAdmin(user, t.toTeamId);
    const save = async () => toTransfer(await prisma.transfer.update({ where: { id: t.id }, data: { status: t.status, history: toJson(t.history) } }));
    const toReleasingClub = async () => {
      t.status = 'awaitingClub';
      await notify(await clubAdminIds(t.fromTeamId), { kind: 'transfer', title: 'A club wants one of your players', body: `${c.name}. The player has agreed. Release or turn down.`, link: transfersLink(c.id) });
    };

    if (response === 'withdraw') {
      // Whoever is on the asking side can call it off while it's open: the player or the club that wants them.
      if (!requesting && !isPlayer) throw forbidden('Only the player or the club that asked can withdraw');
      if (!transferOpen(t)) throw conflict('This transfer is already decided');
      t.status = 'withdrawn';
      t.history.push({ status: 'withdrawn', at, by: isPlayer && !requesting ? 'player' : 'requestingClub', note });
      return save();
    }
    if (response === 'dispute') {
      if (!requesting && !(isPlayer && t.startedBy === 'player')) throw forbidden('Only the club that asked, or the player who asked, can take it to the league');
      if (!(t.status === 'rejected' && t.history.at(-1)?.by === 'releasingClub')) throw conflict('Only a transfer the releasing club turned down can go to the league');
      t.status = 'disputed';
      t.history.push({ status: 'disputed', at, by: isPlayer && !requesting ? 'player' : 'requestingClub', note });
      return save();
    }
    if (t.status === 'awaitingPlayer') {
      if (isPlayer) {
        if (response === 'approve' && (await needsGuardian(t.playerId))) throw conflict(GUARDIAN.replace('They’re', 'You’re').replace('Their club', 'Your club').replace('then they can agree', 'then you can agree'));
        t.history.push({ status: response === 'approve' ? 'awaitingClub' : 'rejected', at, by: 'player', note });
        if (response === 'approve') await toReleasingClub();
        else t.status = 'rejected';
        return save();
      }
      // A player who isn't on Ovalcast can't agree in the app; a league admin records it (a signed form, say).
      if (isLeagueAdmin(user, c.orgId)) {
        if (await playerUser(t.playerId)) throw forbidden('The player is on Ovalcast, so they agree or decline themselves');
        if (response !== 'approve') throw conflict('Only the player can decline. Ask the club to withdraw instead');
        if (!note) throw badRequest('Say how the player agreed, for example “signed form, 12 March”');
        if (await needsGuardian(t.playerId)) throw conflict(GUARDIAN);
        t.history.push({ status: 'awaitingClub', at, by: 'player', note: `Recorded by the league: ${note}` });
        await toReleasingClub();
        return save();
      }
      throw forbidden('Only the player can answer this');
    }
    if (t.status === 'awaitingNewClub') {
      if (!requesting) throw forbidden('Only the club the player wants to join can answer this');
      t.history.push({ status: response === 'approve' ? 'awaitingClub' : 'rejected', at, by: 'requestingClub', note });
      if (response === 'approve') await toReleasingClub();
      else t.status = 'rejected';
      const uid = await playerUser(t.playerId);
      if (uid) await notify([uid], { kind: 'transfer', title: response === 'approve' ? `${await teamName(t.toTeamId)} accepted you` : `${await teamName(t.toTeamId)} turned down your request`, body: response === 'approve' ? `${c.name}. Your club decides next, then the league.` : c.name, link: transfersLink(c.id) });
      return save();
    }
    if (t.status === 'awaitingClub') {
      if (!isClubAdmin(user, t.fromTeamId)) throw forbidden('Only the releasing club can answer this');
      t.status = response === 'approve' ? 'awaitingLeague' : 'rejected';
      t.history.push({ status: t.status, at, by: 'releasingClub', note });
      return save();
    }
    if (t.status === 'awaitingLeague' || t.status === 'disputed') {
      if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can approve transfers');
      if (response === 'approve') {
        // The window and limits are checked again at approval.
        const { regs, verdict } = await transferCheck(t, t.id);
        if (!verdict.ok) throw conflict(verdict.reason);
        const from = regs.find((r) => r.playerId === t.playerId && r.teamId === t.fromTeamId && r.status === 'active');
        if (!from) throw conflict('The player is no longer in that squad');
        await prisma.$transaction(async (tx) => {
          if (t.kind === 'move') {
            await tx.registration.update({ where: { id: from.id }, data: { status: 'ended' } });
            // The home club only changes once the player has no squad place left at the old club in any league.
            const still = await tx.registration.count({ where: { playerId: t.playerId, teamId: t.fromTeamId, status: 'active' } });
            if (!still) await tx.player.update({ where: { id: t.playerId }, data: { teamId: t.toTeamId } });
          }
          await tx.registration.create({ data: { id: newId('reg'), competitionId: c.id, playerId: t.playerId, teamId: t.toTeamId, primary: t.kind === 'move' ? from.primary : false, since: at, status: 'active' } });
        });
      }
      t.status = response === 'approve' ? 'approved' : 'rejected';
      t.history.push({ status: t.status, at, by: 'league', note });
      const uid = await playerUser(t.playerId);
      if (uid) await notify([uid], { kind: 'transfer', title: response === 'approve' ? (t.kind === 'dual' ? `You can now play for ${await teamName(t.toTeamId)} too` : `You’ve moved to ${await teamName(t.toTeamId)}`) : 'The league turned down your transfer', body: c.name, link: transfersLink(c.id) });
      return save();
    }
    throw conflict('This transfer is already decided');
  });

  // Ending a second club: the player, either of their clubs, or a league admin. The main club stays;
  // changing it is a move.
  app.post<{ Params: { id: string } }>('/registrations/:id/end', async (req) => {
    const user = requireUser(req);
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    const reg = await prisma.registration.findUnique({ where: { id: req.params.id } });
    if (!reg || reg.status !== 'active') throw notFound('Squad place');
    const c = await comp(reg.competitionId);
    const main = await prisma.registration.findFirst({ where: { competitionId: reg.competitionId, playerId: reg.playerId, status: 'active', primary: true } });
    if (reg.primary || !main) throw conflict('This is their main club. To change it, ask for a move');
    const allowed = (!!user.playerId && user.playerId === reg.playerId) || isClubAdmin(user, reg.teamId) || isClubAdmin(user, main.teamId) || isLeagueAdmin(user, c.orgId);
    if (!allowed) throw forbidden('Only the player, their clubs or the league can end a second club');
    const ended = await prisma.registration.update({ where: { id: reg.id }, data: { status: 'ended' } });
    const player = await prisma.player.findUnique({ where: { id: reg.playerId }, select: { name: true } });
    const told = new Set([...(await clubAdminIds(reg.teamId)), ...(await clubAdminIds(main.teamId))]);
    const uid = await playerUser(reg.playerId);
    if (uid) told.add(uid);
    told.delete(user.id);
    await notify([...told], { kind: 'transfer', title: `${player?.name ?? 'A player'} no longer plays for ${await teamName(reg.teamId)}`, body: `${c.name}. Their second club ended${note ? `: “${note}”` : '.'}`, link: transfersLink(c.id) });
    return toRegistration(ended);
  });

  // A held player (see lib/registration.ts): a league admin releases them, with a reason the clubs see.
  app.post<{ Params: { id: string } }>('/registrations/:id/release', async (req) => {
    const user = requireUser(req);
    const { note } = z.object({ note: z.string().trim().min(3, 'Say why, for example “approved by the league committee, 4 April”').max(500) }).parse(req.body);
    const reg = await prisma.registration.findUnique({ where: { id: req.params.id } });
    if (!reg || reg.status !== 'active') throw notFound('Squad place');
    const c = await comp(reg.competitionId);
    if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can release a held player');
    if (!reg.heldReason) throw conflict('This player isn’t held');
    const saved = await prisma.registration.update({ where: { id: reg.id }, data: { heldReason: null, overrideNote: note, overrideBy: user.name } });
    const player = await prisma.player.findUnique({ where: { id: reg.playerId }, select: { name: true } });
    const uid = (await prisma.user.findFirst({ where: { playerId: reg.playerId }, select: { id: true } }))?.id;
    await notify([...new Set([...(await clubAdminIds(reg.teamId)), ...(uid ? [uid] : [])])], { kind: 'entry', title: `${player?.name ?? 'A player'} released by the league`, body: `${c.name}: “${note}”`, link: transfersLink(c.id) });
    return toRegistration(saved);
  });

  // The player settles having more than one club in a league: which is their main club (they play for
  // it when the clubs meet) and, where the league allows a second club (QYP), which is the second.
  // Any other squad places they have in this league end.
  app.post<{ Params: { id: string } }>('/competitions/:id/my-clubs', async (req) => {
    const user = requireUser(req);
    const { mainTeamId, secondTeamId } = z.object({ mainTeamId: z.string(), secondTeamId: z.string().optional() }).parse(req.body);
    if (!user.playerId) throw forbidden('Only the player can choose their clubs');
    if (secondTeamId === mainTeamId) throw badRequest('Choose a different second club');
    const c = await comp(req.params.id);
    const mine = new Set([user.playerId, ...(await prisma.player.findMany({ where: { claimedByUserId: user.id }, select: { id: true } })).map((p) => p.id)]);
    const here = await prisma.registration.findMany({ where: { competitionId: c.id, playerId: { in: [...mine] }, status: 'active' } });
    const main = here.find((r) => r.teamId === mainTeamId);
    const second = secondTeamId ? here.find((r) => r.teamId === secondTeamId) : undefined;
    if (!main) throw badRequest('You’re not in that club’s squad for this league');
    if (secondTeamId && !second) throw badRequest('You’re not in that club’s squad for this league');
    // The same rules a new registration meets: main first, then the second beside it.
    const everywhere = (await prisma.registration.findMany({ where: { playerId: { in: [...mine] } } })).map((r) => ({ ...toRegistration(r), playerId: user.id }));
    const elsewhere = everywhere.filter((r) => r.competitionId !== c.id);
    const comps = (await prisma.competition.findMany({ where: { id: { in: [...new Set([c.id, ...elsewhere.map((r) => r.competitionId)])] } } })).map(toCompetition);
    const dob = (await prisma.player.findMany({ where: { id: { in: [...mine] }, dateOfBirth: { not: null } }, select: { dateOfBirth: true } }))[0]?.dateOfBirth;
    const names = new Map((await prisma.team.findMany({ where: { id: { in: here.map((r) => r.teamId) } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const check = (teamId: string, alongside: typeof everywhere) => registrationCheck({ playerId: user.id, teamId, league: c, leagues: comps, regs: [...elsewhere, ...alongside], teamName: (id) => names.get(id) ?? 'another club', playerBirthDate: dob?.toISOString().slice(0, 10), leagueStartsOn: new Date(c.startsOn).toISOString() });
    const mainVerdict = check(mainTeamId, []);
    const mainRef = { ...toRegistration(main), playerId: user.id, status: 'active' as const };
    const secondVerdict = secondTeamId ? check(secondTeamId, [mainRef]) : undefined;
    if (secondVerdict && !secondVerdict.ok && secondVerdict.canChoose) throw conflict(`${names.get(secondTeamId!) ?? 'That club'} can’t be your second club: ${secondVerdict.reason.replace(/^Already plays for [^.;]+[.;] ?/, '')}`);
    await prisma.$transaction(async (tx) => {
      await tx.registration.update({ where: { id: main.id }, data: { primary: true, heldReason: mainVerdict.ok ? null : mainVerdict.reason } });
      if (second && secondVerdict) await tx.registration.update({ where: { id: second.id }, data: { primary: false, heldReason: secondVerdict.ok ? null : secondVerdict.reason } });
      const others = here.filter((r) => r.id !== main.id && r.id !== second?.id).map((r) => r.id);
      if (others.length) await tx.registration.updateMany({ where: { id: { in: others } }, data: { status: 'ended' } });
    });
    const told = new Set<string>();
    for (const r of here) for (const id of await clubAdminIds(r.teamId)) told.add(id);
    await notify([...told], { kind: 'entry', title: `${user.name} chose their clubs in ${c.name}`, body: `Main club: ${names.get(mainTeamId)}${secondTeamId ? `. Second club: ${names.get(secondTeamId)}` : ''}.`, link: transfersLink(c.id) });
    return (await prisma.registration.findMany({ where: { competitionId: c.id, playerId: { in: [...mine] } } })).map(toRegistration);
  });

  // ------------------------------------------------------------- deductions
  app.get<{ Params: { id: string } }>('/competitions/:id/deductions', async (req) => (await prisma.deduction.findMany({ where: { competitionId: req.params.id }, orderBy: { at: 'desc' } })).map(toDeduction));
  app.post<{ Params: { id: string } }>('/competitions/:id/deductions', async (req) => {
    const user = requireUser(req);
    const b = z.object({ teamId: z.string(), points: z.number().int().min(1).max(12), reason: z.enum(['lateStart', 'ineligiblePlayer', 'slowOverRate', 'misconduct', 'unpaidFees', 'forfeit', 'other']), note: z.string().trim().min(1, 'Say what happened. The club sees this.'), matchId: z.string().optional() }).parse(req.body);
    const c = await comp(req.params.id);
    if (!isLeagueAdmin(user, c.orgId)) throw forbidden('Only a league admin can deduct points');
    if (!c.teamIds.includes(b.teamId)) throw badRequest('That club is not in this league');
    const d = await prisma.deduction.create({ data: { id: newId('ded'), competitionId: c.id, ...b, matchId: b.matchId ?? null, status: 'active', by: user.id, byName: user.name, at: new Date() } });
    await notify(await clubAdminIds(b.teamId), { kind: 'discipline', title: `${b.points} point${b.points === 1 ? '' : 's'} deducted in ${c.name}`, body: b.note, link: { pathname: '/competition/[id]', params: { id: c.id } } });
    return toDeduction(d);
  });
  app.post<{ Params: { id: string } }>('/deductions/:id/revoke', async (req) => {
    const user = requireUser(req);
    const d = await prisma.deduction.findUnique({ where: { id: req.params.id } });
    if (!d) throw notFound('Deduction');
    if (!isLeagueAdmin(user, (await comp(d.competitionId)).orgId)) throw forbidden('Only a league admin can revoke a deduction');
    return toDeduction(await prisma.deduction.update({ where: { id: d.id }, data: { status: 'revoked', revokedAt: new Date() } }));
  });
}
