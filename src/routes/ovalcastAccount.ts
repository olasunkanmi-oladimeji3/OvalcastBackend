// Ovalcast's own account, for staff: what Ovalcast earned, kept apart by where it came from (streams,
// league entry fees, plans, viewer credits), what staff have moved to Ovalcast's bank, what is
// still with Flutterwave, and the money held for other people (streamers' balances, fans' wallets).
// Each currency is kept separate; nothing is converted.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OvalcastAccount } from '@/api/types';
import { json, prisma } from '~/db/client';
import { requireStaff } from '~/lib/auth';
import { newId } from '~/lib/ids';
import { logMoney } from '~/lib/moneyLog';
import { logStaff } from '~/lib/staffLog';
import { entryShareFor } from '~/lib/shares';

type Income = OvalcastAccount['currencies'][number]['allTime'];
const empty = (): Income => ({ streams: 0, leagueFees: 0, plans: 0, viewerCredits: 0, total: 0 });

/** Everything Ovalcast earned since `from` (or ever), per currency and source. */
async function earned(from?: Date) {
  const since = from ? { gte: from } : undefined;
  const [passes, donations, checkouts] = await Promise.all([
    // Streams: what's left of each pass and donation after the payment fee and the host's share
    // (an approved streamer's part comes out of the host's share, never Ovalcast's).
    prisma.matchPass.findMany({ where: { status: { not: 'refunded' }, ...(since ? { at: since } : {}) }, select: { price: true, fee: true, hostShare: true, currency: true } }),
    prisma.donation.findMany({ where: since ? { at: since } : {}, select: { amount: true, fee: true, hostShare: true, currency: true } }),
    // League entry fees (Ovalcast's share, kept by Flutterwave before the league is paid), plans and viewer credits.
    prisma.checkout.findMany({ where: { status: 'paid', kind: { in: ['entry', 'pro', 'organisation', 'credits'] }, ...(since ? { paidAt: since } : {}) }, select: { kind: true, amount: true, currency: true, meta: true, refId: true, paidAt: true } }),
  ]);
  // Older entry payments didn't record their rate: those use the league's rate now (its own, or the global one).
  const missing = checkouts.filter((c) => c.kind === 'entry' && typeof json<{ serviceRate?: number }>(c.meta).serviceRate !== 'number' && c.refId);
  const orgOfEntry = new Map((await prisma.entry.findMany({ where: { id: { in: missing.map((c) => c.refId!) } }, select: { id: true, competition: { select: { orgId: true } } } })).map((e) => [e.id, e.competition.orgId]));
  const orgRate = new Map<string, number>();
  for (const orgId of new Set(orgOfEntry.values())) orgRate.set(orgId, await entryShareFor(orgId));
  const rateOf = (c: (typeof checkouts)[number]) => json<{ serviceRate?: number }>(c.meta).serviceRate ?? orgRate.get(orgOfEntry.get(c.refId ?? '') ?? '') ?? 0;
  const by = new Map<string, Income>();
  const add = (currency: string, key: Exclude<keyof Income, 'total'>, n: number) => {
    const t = by.get(currency) ?? empty();
    t[key] += n;
    t.total += n;
    by.set(currency, t);
  };
  for (const p of passes) add(p.currency, 'streams', p.price - (p.fee ?? 0) - (p.hostShare ?? 0));
  for (const d of donations) add(d.currency, 'streams', d.amount - d.fee - d.hostShare);
  for (const c of checkouts) {
    if (c.kind === 'entry') {
      add(c.currency, 'leagueFees', Math.round(c.amount * rateOf(c)));
    } else add(c.currency, c.kind === 'credits' ? 'viewerCredits' : 'plans', c.amount);
  }
  return { by, entries: checkouts.filter((c) => c.kind === 'entry'), rateOf };
}

export async function ovalcastAccountRoutes(app: FastifyInstance) {
  app.get('/staff/ovalcast-account', async (req): Promise<OvalcastAccount> => {
    requireStaff(req);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }).parse(req.query);
    const from = new Date(Date.now() - days * 86_400_000);
    const [period, ever, settled, owedSales, owedPaid, wallets, settlements] = await Promise.all([
      earned(from),
      earned(),
      prisma.ovalcastSettlement.groupBy({ by: ['currency'], _sum: { amount: true } }),
      prisma.passSale.groupBy({ by: ['currency'], _sum: { host: true } }),
      prisma.hostPayout.groupBy({ by: ['currency'], where: { status: { not: 'failed' } }, _sum: { amount: true } }),
      prisma.wallet.groupBy({ by: ['currency'], _sum: { balance: true } }),
      prisma.ovalcastSettlement.findMany({ orderBy: { at: 'desc' }, take: 50 }),
    ]);

    // League fees in the period, per league, so each league's contribution is clear.
    const entryIds = period.entries.map((c) => c.refId).filter((x): x is string => !!x);
    const entryRows = await prisma.entry.findMany({ where: { id: { in: entryIds } }, select: { id: true, competition: { select: { orgId: true, org: { select: { name: true } } } } } });
    const orgOf = new Map(entryRows.map((e) => [e.id, { id: e.competition.orgId, name: e.competition.org.name }]));
    const leagues = new Map<string, OvalcastAccount['leagues'][number]>();
    for (const c of period.entries) {
      const org = c.refId ? orgOf.get(c.refId) : undefined;
      if (!org) continue;
      const key = `${org.id}|${c.currency}`;
      const row = leagues.get(key) ?? { orgId: org.id, name: org.name, currency: c.currency, payments: 0, collected: 0, ovalcast: 0 };
      row.payments += 1;
      row.collected += c.amount;
      row.ovalcast += Math.round(c.amount * period.rateOf(c));
      leagues.set(key, row);
    }

    const sum = <T extends { currency: string | null }>(rows: T[], get: (r: T) => number | null | undefined) => {
      const m = new Map<string, number>();
      for (const r of rows) if (r.currency) m.set(r.currency, (m.get(r.currency) ?? 0) + (get(r) ?? 0));
      return m;
    };
    const settledBy = sum(settled, (r) => r._sum.amount);
    const owed = sum(owedSales, (r) => r._sum.host);
    for (const [c, n] of sum(owedPaid, (r) => r._sum.amount)) owed.set(c, (owed.get(c) ?? 0) - n);
    const walletsBy = sum(wallets, (r) => r._sum.balance);
    const currencies = [...new Set([...ever.by.keys(), ...settledBy.keys(), ...owed.keys(), ...walletsBy.keys()])].sort();

    return {
      days,
      currencies: currencies.map((currency) => {
        const allTime = ever.by.get(currency) ?? empty();
        const settledTotal = settledBy.get(currency) ?? 0;
        return {
          currency,
          period: period.by.get(currency) ?? empty(),
          allTime,
          settled: settledTotal,
          withFlutterwave: allTime.total - settledTotal,
          heldForStreamers: Math.max(0, owed.get(currency) ?? 0),
          heldInWallets: walletsBy.get(currency) ?? 0,
        };
      }),
      leagues: [...leagues.values()].sort((a, b) => b.ovalcast - a.ovalcast),
      settlements: settlements.map((s) => ({ id: s.id, at: s.at.toISOString(), amount: s.amount, currency: s.currency, reference: s.reference, note: s.note ?? undefined, staffName: s.staffName })),
    };
  });

  // Staff record money moved from Flutterwave to Ovalcast's bank, with the reference.
  app.post('/staff/ovalcast-account/settlements', async (req) => {
    const staff = requireStaff(req);
    const b = z.object({ amount: z.number().int().min(1), currency: z.string().length(3).toUpperCase(), reference: z.string().trim().min(3, 'Give the bank or Flutterwave reference').max(100), note: z.string().trim().max(200).optional() }).parse(req.body);
    const id = newId('ovs');
    await prisma.ovalcastSettlement.create({ data: { id, amount: b.amount, currency: b.currency, reference: b.reference, note: b.note || null, staffId: staff.id, staffName: staff.name } });
    await logStaff(staff, 'ovalcastSettlement', 'settlement', id, `${b.currency} ${b.amount}, ${b.reference}`);
    await logMoney(req, { userId: staff.id, action: 'ovalcastSettlement', amount: b.amount, currency: b.currency, reference: b.reference, detail: b.note });
    return { ok: true as const, id };
  });
}
