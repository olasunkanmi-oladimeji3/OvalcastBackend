// Loads the demo world into Postgres: the same clubs, leagues, people and
// fixtures as the app's demo mode. Every completed match is played out ball by
// ball, so tables, careers and leaderboards come from real ball events.
//
//   npm run db:seed          (empties the tables first)

import 'dotenv/config';
import { createSeed, refreshFromEvents, REGIONS, setupFor } from '@/api/mock/seed';
import { splitPass } from '@/engine/billing';
import { mulberry32, simulate } from '@/api/mock/simulate';
import { Prisma, prisma } from '~/db/client';
import { hashPassword, sha256 } from '~/lib/crypto';
import { seal } from '~/lib/secrets';
import { storage } from '~/lib/storage';
import { matchData } from '~/lib/repo';
import { appEnv } from '~/lib/config';


/** createMany rejects a bare null for a Json column; DbNull writes SQL NULL. */
const JSON_COLS = new Set(['meta', 'officiating', 'payment', 'link', 'rulesDocument', 'toss', 'playingXI', 'result', 'conditions', 'placeholders', 'winnerTo']);
const nullsForJson = (row: object) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null && JSON_COLS.has(k) ? Prisma.DbNull : v]));

/**
 * The seed empties every table first. Never on production, and only on a database on another
 * machine (a staging database) when asked for in so many words: npm run db:seed -- --wipe.
 */
function refuseUnlessSafe() {
  if (appEnv() === 'production') throw new Error('Refusing to seed: this is production (NODE_ENV=production without APP_ENV=staging). The seed empties every table.');
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').hostname;
    } catch {
      return '';
    }
  })();
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (!local && !process.argv.includes('--wipe')) throw new Error(`Refusing to seed ${host || 'that database'}: it isn't on this machine, and the seed empties every table. Run npm run db:seed -- --wipe if that's really what you want (staging only).`);
}

async function main() {
  refuseUnlessSafe();
  // Every table but the migration history, so a table added later can't keep old rows (ratings, settings did).
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>("select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'");
  await prisma.$executeRawUnsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`);
  const demo = createSeed(new Date());

  // Play out every completed match that only had a summary score.
  let played = 0;
  for (const m of demo.matches) {
    if (m.status !== 'completed' || demo.balls[m.id]?.length) continue;
    const xi = (teamId: string) => demo.players.filter((p) => p.teamId === teamId && !p.guest).slice(0, 11).map((p) => p.id);
    m.playingXI = { [m.homeTeamId]: xi(m.homeTeamId), [m.awayTeamId]: xi(m.awayTeamId) };
    m.battingFirstTeamId ??= m.homeTeamId;
    demo.balls[m.id] = simulate(setupFor(demo, m), [], mulberry32(m.id.length * 7919 + m.id.charCodeAt(m.id.length - 1) * 31 + played), m.id, new Date(m.startsAt));
    refreshFromEvents(demo, m);
    played += 1;
  }

  const passwordHash = await hashPassword('cricket123');
  // Prisma's createMany per model; JSON columns take plain values and ISO strings become dates.
  type Delegate = { createMany(args: { data: never[] }): Promise<unknown> };
  const insert = async (model: Delegate, rows: object[]) => {
    for (let i = 0; i < rows.length; i += 500) await model.createMany({ data: rows.slice(i, i + 500).map(nullsForJson) as never[] });
  };

  await insert(prisma.region, REGIONS);
  await insert(prisma.organisation, [demo.org, ...demo.otherOrgs].map((o) => ({ id: o.id, name: o.name, shortName: o.shortName, city: o.city, country: o.country, currency: o.currency, about: o.about, founded: o.founded, executives: o.executives, sponsors: o.sponsors, honours: o.honours, seasonMoves: o.seasonMoves, plan: o.plan ?? 'free', kind: o.kind ?? 'league', ...(o.id === demo.org.id ? { embedsRequestedAt: new Date(Date.now() - 20 * 86_400_000), embedsApprovedAt: new Date(Date.now() - 19 * 86_400_000), embedsApprovedBy: 'Ada Okonkwo', embedDomains: ['localhost:5500', 'ccclagos.com'] } : {}), viewerHoursLeft: demo.viewerCredits[o.id]?.hoursLeft ?? 0, viewerHoursUsed: demo.viewerCredits[o.id]?.hoursUsed ?? 0 })));
  await insert(
    prisma.user,
    demo.users.map((u, i) => {
      const o = demo.officiating[u.id];
      return {
        // Joined over the past months, so the backoffice shows a history.
        createdAt: new Date(Date.now() - (120 - i * 13) * 86_400_000).toISOString(),
        id: u.id, name: u.name, email: u.email ?? null, phone: u.phone ?? null, emailVerified: u.emailVerified, phoneVerified: u.phoneVerified, passwordHash, city: u.city ?? null, country: u.country ?? null, staff: !!u.staff, follows: (u.follows ?? {}) as never, playerId: u.playerId ?? null, settings: u.settings,
        officiating: o ? { roles: o.roles, available: o.available, days: o.days, travelKm: o.travelKm, fee: o.fee, bio: o.bio, grounds: o.grounds } : null,
      };
    }),
  );
  await insert(prisma.membership, demo.users.flatMap((u) => u.memberships.map((m, i) => ({ id: `mem_${u.id}_${i}`, userId: u.id, orgId: m.orgId ?? null, clubId: m.clubId ?? null, role: m.role }))));
  await insert(prisma.certificate, Object.entries(demo.officiating).flatMap(([userId, o]) => o.certificates.map((c) => ({ id: c.id, userId, role: c.role, title: c.title, issuer: c.issuer, year: c.year, fileName: c.fileName, fileKey: `certificates/demo/${c.id}.pdf`, status: c.status, uploadedAt: c.uploadedAt }))));
  await insert(prisma.team, demo.teams.map((t) => ({ id: t.id, orgId: t.orgId ?? null, name: t.name, shortName: t.shortName, colors: t.colors, homeGround: t.homeGround, city: t.city, founded: t.founded, logoUrl: t.logoUrl ?? null, staff: t.staff, adHoc: !!t.adHoc })));
  await insert(prisma.player, demo.players.map((p) => ({ id: p.id, teamId: p.teamId, name: p.name, shortName: p.shortName, role: p.role, battingHand: p.battingHand, bowlingStyle: p.bowlingStyle ?? null, guest: !!p.guest, guestMatchId: p.guestMatchId ?? null })));
  await insert(prisma.playerInvite, demo.playerInvites);
  await insert(
    prisma.competition,
    demo.competitions.map((c) => ({ id: c.id, orgId: c.orgId, seriesId: c.seriesId ?? c.id, category: c.category ?? 'league', tier: c.tier ?? null, name: c.name, season: c.season, division: c.division, format: c.format, ballType: c.ballType, conditions: c.conditions, points: c.points, tieBreakers: c.tieBreakers, stages: c.stages, teamIds: c.teamIds, status: c.status, entryPolicy: c.entryPolicy, entryFee: c.entryFee, maxTeams: c.maxTeams, startsOn: c.startsOn, playerRules: c.playerRules, rulesDocument: c.rulesDocument ?? null, seasonRules: c.seasonRules })),
  );
  await insert(prisma.match, demo.matches.map((m) => ({ id: m.id, ...matchData(m) })));
  await prisma.$executeRawUnsafe(`update matches set started_at = starts_at where status not in ('scheduled', 'toss')`);
  await insert(
    prisma.ballEvent,
    Object.entries(demo.balls).flatMap(([matchId, events]) => events.map((e) => ({ id: e.id, matchId, clientId: e.clientId, innings: e.innings, seq: e.seq, kind: e.kind, event: e, strikerId: e.strikerId ?? null, bowlerId: e.bowlerId ?? null, createdBy: e.createdBy === 'demo-scorer' ? 'user_ngozi' : e.createdBy, createdAt: e.createdAt }))),
  );
  await insert(prisma.entry, demo.entries.map((e) => ({ ...e, message: e.message ?? null, payment: e.payment ?? null, respondedAt: e.respondedAt ?? null })));
  await insert(prisma.registration, demo.registrations);
  await insert(prisma.transfer, demo.transfers.map((t) => ({ ...t, note: t.note ?? null })));
  await insert(prisma.deduction, demo.deductions.map((d) => ({ ...d, matchId: d.matchId ?? null, revokedAt: d.revokedAt ?? null })));
  await insert(prisma.officialInvite, demo.officialInvites.map((i) => ({ ...i, note: i.note ?? null })));
  await insert(prisma.notification, demo.notifications.map((n) => ({ id: n.id, userId: n.userId, kind: n.kind, title: n.title, body: n.body, link: n.link ?? null, read: n.read, at: n.at })));
  await insert(prisma.post, demo.posts.map((p) => ({ id: p.id, kind: p.kind, regionId: p.regionId, title: p.title, body: p.body, authorId: null, authorName: p.authorName, teamId: p.teamId ?? null, whatsapp: p.whatsapp, when: p.when ?? null, createdAt: p.createdAt })));
  await insert(prisma.payoutAccount, Object.values(demo.payoutAccounts).map((a) => ({ orgId: a.orgId, kind: a.kind, institution: a.institution, institutionCode: a.institutionCode, last4: a.last4, accountName: a.accountName, provider: 'flutterwave', subaccountCode: `RS_demo${a.last4}`, schedule: a.schedule, verifiedAt: a.verifiedAt, changedBy: 'user_me', changedByName: a.changedByName, holdUntil: a.holdUntil ?? null })));
  await insert(prisma.settlement, demo.settlements);
  await insert(prisma.subscription, demo.subscriptions);
  await insert(prisma.playerClaim, demo.claims.map((c) => ({ ...c, note: c.note ?? null, respondedAt: c.respondedAt ?? null })));
  await insert(prisma.youTubeKey, Object.keys(demo.youtube).map((ownerId) => ({ ownerId, ownerKind: demo.org.id === ownerId || demo.otherOrgs.some((o) => o.id === ownerId) ? 'organisation' : 'team', keyEnc: seal('demo-yt-key-0000') })));
  // The CCC Lagos website's sandbox key, fixed in development so the partner API can be tried at once.
  const demoKey = 'ovl_test_ccc_website_demo_key';
  await prisma.apiClient.create({ data: { id: 'api_ccc_site', orgId: demo.org.id, name: 'CCC Lagos website', keyHash: sha256(demoKey), keyPrefix: demoKey.slice(0, 13), sandbox: true } });
  // Rules documents: a small PDF per competition that has one, so the download works.
  for (const c of demo.competitions.filter((x) => x.rulesDocument)) {
    const key = `rules/${c.id}/v${c.rulesDocument!.version}-${c.rulesDocument!.name}`;
    await storage.put(key, Buffer.from(`%PDF-1.4\n% ${c.name} rules, demo copy\n%%EOF\n`), 'application/pdf');
    await prisma.ruleDocument.create({ data: { id: `rule_${c.id}_${c.rulesDocument!.version}`, competitionId: c.id, version: c.rulesDocument!.version, name: c.rulesDocument!.name, sizeKb: c.rulesDocument!.sizeKb, fileKey: key, uploadedBy: 'user_me', uploadedByName: demo.me.name, uploadedAt: c.rulesDocument!.uploadedAt } });
  }
  await insert(prisma.wallet, Object.entries(demo.wallets).map(([userId, w]) => ({ userId, balance: w.balance })));
  await insert(prisma.walletEntry, Object.entries(demo.wallets).flatMap(([userId, w]) => w.entries.map((e) => ({ ...e, userId }))));
  await insert(prisma.passOffer, Object.entries(demo.passOffers).map(([matchId, o]) => ({ matchId, price: o.price, currency: 'NGN', hostUserId: o.hostUserId, hostName: o.hostName, season: false })));
  // Each sale as the passes viewers bought, split the way a real sale is (wallet passes pay no payment
  // fee; these were sold when hosts kept 70%), and each match's totals added up from them, so the
  // backoffice, the streamer's earnings and the purchase list agree.
  const buyers = demo.users.filter((u) => !u.staff).map((u) => u.id);
  const methods = ['card', 'bankTransfer', 'ussd', 'mobileMoney', 'wallet'] as const;
  const passes = demo.passSales.flatMap((sale, si) =>
    Array.from({ length: sale.passes }, (_, i) => {
      const price = Math.round(sale.gross / sale.passes);
      const paidWith = methods[(si + i) % methods.length];
      const split = splitPass(price, demo.org.currency, 0.3, paidWith);
      return {
        id: `pass_demo_${si}_${i}`,
        userId: buyers.filter((b) => b !== sale.hostUserId)[(si * 7 + i) % (buyers.length - 1)],
        matchId: sale.matchId,
        competitionId: null,
        price,
        currency: demo.org.currency,
        paidWith,
        status: 'active',
        hostUserId: sale.hostUserId,
        fee: split.providerFee,
        hostShare: split.host,
        platformShare: 0.3,
        // Bought across the hours around the match.
        at: new Date(new Date(sale.at).getTime() - ((i * 37) % 300) * 60_000).toISOString(),
      };
    }),
  );
  await insert(
    prisma.passSale,
    demo.passSales.map((x) => {
      const mine = passes.filter((p) => p.matchId === x.matchId && p.hostUserId === x.hostUserId);
      return { ...x, currency: demo.org.currency, gross: mine.reduce((t, p) => t + p.price, 0), fees: mine.reduce((t, p) => t + p.fee, 0), host: mine.reduce((t, p) => t + p.hostShare, 0) };
    }),
  );
  await insert(prisma.matchPass, passes);
  // Ratings people gave officials, so Find officials shows real ones.
  await insert(prisma.rating, demo.ratings.map((r) => ({ id: r.id, userId: r.userId, raterId: r.raterId, raterName: r.raterName, role: r.role, matchId: r.matchId ?? null, scores: r.scores, comment: r.comment ?? null, at: r.at })));
  // Payments through Flutterwave: entry fees already paid, wallet top-ups, and one that failed.
  const paidEntries = demo.entries.filter((e) => e.payment?.status === 'paid');
  await insert(prisma.checkout, [
    ...paidEntries.map((e) => ({ id: `chk_${e.id}`, kind: 'entry', userId: 'user_me', refId: e.id, amount: e.payment!.amount, currency: e.payment!.currency, status: 'paid', meta: {}, method: e.payment!.method, providerId: e.payment!.reference, createdAt: e.payment!.at, paidAt: e.payment!.at })),
    ...Object.entries(demo.wallets).flatMap(([userId, w]) => w.entries.filter((x) => x.kind === 'topUp').map((x) => ({ id: `chk_${x.id}`, kind: 'topUp', userId, refId: null, amount: x.amount, currency: demo.org.currency, status: 'paid', meta: {}, method: 'card', providerId: x.reference, createdAt: x.at, paidAt: x.at }))),
    { id: 'chk_failed_demo', kind: 'topUp', userId: 'user_adewale', refId: null, amount: 5000, currency: demo.org.currency, status: 'failed', meta: {}, method: 'card', providerId: null, createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(), paidAt: null },
  ]);
  await insert(prisma.hostPayout, Object.entries(demo.hostPayouts).flatMap(([userId, ps]) => ps.map((x) => ({ ...x, userId, currency: demo.org.currency }))));
  await insert(prisma.viewerCreditPurchase, Object.values(demo.viewerCredits).flatMap((v) => v.purchases.map((x) => ({ ...x, orgId: v.orgId }))));
  await insert(prisma.stream, demo.streams);
  await insert(prisma.clip, demo.clips);
  await insert(prisma.story, demo.stories.map(({ likedBy: _, ...st }) => ({ ...st, teamId: st.teamId ?? null, matchId: st.matchId ?? null, competitionId: st.competitionId ?? null })));
  await insert(prisma.storyLike, demo.stories.flatMap((st) => st.likedBy.map((userId) => ({ storyId: st.id, userId }))));
  await insert(prisma.storyComment, demo.storyComments);

  const counts = { users: await prisma.user.count(), teams: await prisma.team.count(), players: await prisma.player.count(), matches: await prisma.match.count(), balls: await prisma.ballEvent.count() };
  console.log(`Seeded. ${played} matches played out ball by ball.`, counts);
  console.log(`Partner API sandbox key for CCC Lagos: ${'ovl_test_ccc_website_demo_key'}`);
  console.log('Sign in with any demo account, password cricket123: tunde@ovalcast.app (league and club admin), ngozi@ovalcast.app (scorer).');
  // A running development server holds matches and pages in memory: tell it the data was replaced.
  const port = process.env.PORT ?? 4000;
  await fetch(`http://localhost:${port}/health/flush`, { method: 'POST' }).then(() => console.log('Emptied the running server’s caches.'), () => {});
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
