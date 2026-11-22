// Plans, Pro, the wallet, paid streams, host earnings and viewer credits.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HostEarnings, MatchPass, PassOffer, PlanStatus, Subscription, User, ViewerCredits, Wallet } from '@/api/types';
import { VIEWER_CREDIT_PACK, currencyForCountry, donationSuggestions, minimumDonation, formatMoney, hostPayoutMinimum, viewerCreditPackPrice, walletTopUps, type FinanceCurrency, minimumPassPrice, nextHostPayout, proPrice, type BillingInterval, type PlayingConditions } from '@/engine';
import type * as P from '~/generated/prisma/client';
import { json, prisma, Prisma } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { oneAtATime } from '~/lib/lock';
import { platformShareFor } from '~/lib/shares';
import { newId } from '~/lib/ids';
import { isLeagueAdmin } from '~/lib/repo';
import { limitsOf } from '~/services/access';
import { canHost, issuePass, leaguePlan, matchesThisMonth, passFor, recordDonation, startCheckout, userPlan, walletCurrency } from '~/services/billing';
import { organisesMatch } from '~/lib/streaming';
import { hostBalances } from './payouts';
import { getMatch } from '~/services/matches';
import { emit, on } from '~/lib/bus';
import { TtlCache, registerCache } from '~/lib/cache';

const METHOD = z.enum(['card', 'bankTransfer', 'ussd', 'mobileMoney']);
const limit = (n: number) => (Number.isFinite(n) ? n : null);

const toSubscription = (s: P.Subscription): Subscription => ({
  id: s.id, plan: 'pro', interval: s.interval as BillingInterval, status: s.status as Subscription['status'], currency: s.currency as Subscription['currency'], amount: s.amount,
  startedAt: s.startedAt.toISOString(), renewsAt: s.renewsAt.toISOString(), cancelAtPeriodEnd: s.cancelAtPeriodEnd, provider: s.provider as Subscription['provider'],
});
const toPass = (p: P.MatchPass): MatchPass => ({ id: p.id, userId: p.userId, matchId: p.matchId ?? undefined, competitionId: p.competitionId ?? undefined, price: p.price, currency: p.currency as MatchPass['currency'], paidWith: p.paidWith as MatchPass['paidWith'], status: p.status as MatchPass['status'], at: p.at.toISOString() });


// Everyone opening a streamed match asks for its pass price. Each viewer's answer is kept briefly;
// any change (a price set, a pass bought or refunded) empties it on every server process.
const offers = registerCache(new TtlCache<PassOffer | null>(50_000));
on('responses:clear', () => offers.clear());

function offerFor(matchId: string, userId?: string): Promise<PassOffer | null> {
  return offers.remember(`${userId ?? ''}:${matchId}`, 30_000, () => offerNow(matchId, userId));
}

async function offerNow(matchId: string, userId?: string): Promise<PassOffer | null> {
  const o = await prisma.passOffer.findUnique({ where: { matchId } });
  if (!o) return null;
  const mine = await passFor(userId, matchId);
  const currency = o.currency as PassOffer['currency'];
  if (o.mode === 'donation') {
    // The thank-you list: the latest gifts, named unless the giver asked to stay anonymous.
    const gifts = await prisma.donation.findMany({ where: { matchId }, orderBy: { at: 'desc' }, take: 12 });
    return {
      matchId, mode: 'donation', price: 0, currency, hostUserId: o.hostUserId, hostName: o.hostName,
      suggested: json<number[] | null>(o.suggested) ?? donationSuggestions(currency), minimum: minimumDonation(currency),
      supporters: gifts.map((g) => ({ name: g.anonymous ? 'Anonymous' : g.donorName, amount: g.amount, message: g.message ?? undefined, at: g.at.toISOString() })),
    };
  }
  return { matchId, mode: 'payPerView', price: o.price, currency, hostUserId: o.hostUserId, hostName: o.hostName, mine: mine ? toPass(mine) : undefined };
}

export async function billingRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ after paying
  // Flutterwave sends payers back with ?ref=; the payment itself is confirmed by its webhook, so
  // the page asks here until it's paid or failed. Only the payer can see their payment.
  app.get<{ Params: { reference: string } }>('/payments/:reference', async (req) => {
    const user = requireUser(req);
    const c = await prisma.checkout.findUnique({ where: { id: req.params.reference } });
    if (!c || c.userId !== user.id) throw notFound('Payment');
    return { reference: c.id, status: c.status, kind: c.kind, amount: c.amount, currency: c.currency, refId: c.refId ?? undefined };
  });

  // ------------------------------------------------------------------ plan
  app.get('/me/plan', async (req): Promise<PlanStatus> => {
    const user = requireUser(req);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { country: true } });
    const plan = await userPlan(user.id);
    const lim = await limitsOf(plan);
    const adminOrgIds = user.memberships.filter((m) => m.orgId && (m.role === 'leagueAdmin' || m.role === 'owner')).map((m) => m.orgId!);
    const orgs = await prisma.organisation.findMany({ where: { id: { in: adminOrgIds } }, select: { id: true, name: true, plan: true } });
    const own = orgs.filter((o) => o.plan !== 'organisation').map((o) => o.id);
    const sub = await prisma.subscription.findFirst({ where: { userId: user.id, orgId: null, status: { not: 'cancelled' } }, orderBy: { renewsAt: 'desc' } });
    return {
      plan,
      subscription: sub ? toSubscription(sub) : undefined,
      limits: { activeLeagues: limit(lim.activeLeagues), teamsPerLeague: limit(lim.teamsPerLeague), matchesPerMonth: limit(lim.matchesPerMonth) },
      usage: { activeLeagues: own.length ? await prisma.competition.count({ where: { orgId: { in: own }, status: { not: 'completed' } } }) : 0, matchesThisMonth: await matchesThisMonth({ scorerUserId: user.id }) },
      proPrice: proPrice(row.country ?? undefined),
      organisationPlans: orgs.filter((o) => o.plan === 'organisation').map((o) => ({ orgId: o.id, name: o.name })),
    };
  });

  app.post('/me/subscription', async (req) => {
    const user = requireUser(req);
    const b = z.object({ interval: z.enum(['monthly', 'yearly']), method: METHOD }).parse(req.body);
    if ((await userPlan(user.id)) === 'pro') throw conflict('You already have Pro');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { country: true } });
    const price = proPrice(row.country ?? undefined);
    return startCheckout({ kind: 'pro', user, amount: b.interval === 'monthly' ? price.monthly : price.yearly, currency: price.currency, method: b.method, title: `Ovalcast Pro, ${b.interval}`, meta: { interval: b.interval } });
  });

  app.delete('/me/subscription', async (req) => {
    const user = requireUser(req);
    const sub = await prisma.subscription.findFirst({ where: { userId: user.id, orgId: null, status: 'active' } });
    if (!sub) throw notFound('Subscription');
    // Pro stays on to the end of the period; the payment plan stops renewing.
    return toSubscription(await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } }));
  });

  // ---------------------------------------------------------------- wallet
  app.get('/me/wallet', async (req): Promise<Wallet> => {
    const user = requireUser(req);
    const [w, entries] = await Promise.all([prisma.wallet.findUnique({ where: { userId: user.id } }), prisma.walletEntry.findMany({ where: { userId: user.id }, orderBy: { at: 'desc' }, take: 100 })]);
    return { balance: w?.balance ?? 0, currency: await walletCurrency(user.id), entries: entries.map((e) => ({ id: e.id, kind: e.kind as Wallet['entries'][0]['kind'], amount: e.amount, note: e.note, reference: e.reference, at: e.at.toISOString() })) };
  });

  app.post('/me/wallet/top-ups', async (req) => {
    const user = requireUser(req);
    const b = z.object({ amount: z.number().int(), method: METHOD }).parse(req.body);
    const currency = await walletCurrency(user.id);
    if (!walletTopUps(currency).includes(b.amount)) throw badRequest('Pick one of the top-up amounts');
    return startCheckout({ kind: 'topUp', user, amount: b.amount, currency, method: b.method, title: 'Ovalcast wallet top-up' });
  });

  // ---------------------------------------------------------- paid streams
  app.get<{ Params: { id: string } }>('/matches/:id/pass-offer', async (req) => offerFor(req.params.id, req.user?.id));

  // The organiser sets how the stream earns: pay per view at a price, or donations (free to watch).
  // `{ price }` alone is pay per view, as before; null removes the offer (free, nothing to give).
  app.put<{ Params: { id: string } }>('/matches/:id/pass-offer', async (req) => {
    const user = requireUser(req);
    const b = z.object({ price: z.number().int().positive().nullable().optional(), mode: z.enum(['payPerView', 'donation']).optional(), suggested: z.array(z.number().int().positive()).min(1).max(3).optional() }).parse(req.body);
    const m = await prisma.match.findUnique({ where: { id: req.params.id }, include: { competition: { include: { org: true } } } });
    if (!m) throw notFound('Match');
    if (!(await organisesMatch(user, await getMatch(m.id)))) throw forbidden('Only the match’s organiser sets how its stream earns: a league admin, or for a friendly its creator or a club admin');
    if (!(await canHost(user, m))) throw forbidden('Selling match passes needs Pro, or a league on the Organisation plan');
    const mode = b.mode ?? 'payPerView';
    if (b.price === null) {
      await prisma.passOffer.deleteMany({ where: { matchId: m.id } });
      emit('responses:clear', null);
      return null;
    }
    if (mode === 'donation') {
      const currency = (m.competition?.org.currency as FinanceCurrency | undefined) ?? currencyForCountry(user.country);
      const min = minimumDonation(currency);
      const suggested = [...new Set(b.suggested ?? donationSuggestions(currency))].sort((x, y) => x - y);
      if (suggested.some((v) => v < min)) throw badRequest(`Suggested amounts start at ${formatMoney(min, currency)}`);
      // Passes already bought for this match stay valid; new viewers watch free.
      const data = { price: 0, currency, hostUserId: user.id, hostName: user.name, season: false, mode: 'donation', suggested: suggested };
      await prisma.passOffer.upsert({ where: { matchId: m.id }, create: { matchId: m.id, ...data }, update: data });
      emit('responses:clear', null);
      return offerFor(m.id, user.id);
    }
    const price = b.price;
    if (!price) throw badRequest('Set a price for each pass');
    const overs = (json<PlayingConditions | null>(m.conditions) ?? json<PlayingConditions | null>(m.competition?.conditions))?.oversPerInnings ?? 20;
    // League matches are priced in the organisation's currency; friendlies in the host's.
    const currency = (m.competition?.org.currency as FinanceCurrency | undefined) ?? currencyForCountry(user.country);
    const min = minimumPassPrice(overs, currency);
    if (price < min) throw badRequest(`The lowest price for a ${overs}-over match is ${formatMoney(min, currency)}`);
    const data = { price, currency, hostUserId: user.id, hostName: user.name, season: false, mode: 'payPerView', suggested: Prisma.DbNull };
    await prisma.passOffer.upsert({ where: { matchId: m.id }, create: { matchId: m.id, ...data }, update: data });
    emit('responses:clear', null);
    return offerFor(m.id, user.id);
  });

  app.post<{ Params: { id: string } }>('/matches/:id/passes', async (req) => {
    const user = requireUser(req);
    const b = z.object({ paidWith: z.union([z.literal('wallet'), METHOD]) }).parse(req.body);
    const matchId = req.params.id;
    // One purchase per viewer and match at a time: a double tap waits for the first, then finds the pass.
    return oneAtATime(`pass:${user.id}:${matchId}`, async () => {
      const o = await prisma.passOffer.findUnique({ where: { matchId } });
      if (!o) throw notFound('Paid stream');
      if (o.mode === 'donation') throw conflict('This stream is free to watch. You can give what you like instead.');
      if (o.hostUserId === user.id) throw conflict('You host this stream');
      // Read from the database, not the cache: the pass may have been bought a moment ago.
      const had = await passFor(user.id, matchId);
      if (had) return { status: 'paid' as const, reference: had.id.toUpperCase(), alreadyHad: true };
      const price = o.price;
      if (b.paidWith === 'wallet') {
        const wc = await walletCurrency(user.id);
        if (wc !== o.currency) throw conflict(`This pass is priced in ${o.currency} and your wallet is in ${wc}. Pay by card instead; your bank converts it.`);
        // Take the money only if it is there, in one statement.
        const taken = await prisma.wallet.updateMany({ where: { userId: user.id, balance: { gte: price } }, data: { balance: { decrement: price } } });
        if (!taken.count) throw conflict('Not enough in your wallet. Top it up, or pay by card or transfer.');
        try {
          await prisma.walletEntry.create({ data: { id: newId('w'), userId: user.id, kind: 'pass', amount: -price, note: 'Match pass', reference: `PASS-${newId('x').slice(-6).toUpperCase()}` } });
          await issuePass({ userId: user.id, matchId, price, currency: o.currency, paidWith: 'wallet' });
        } catch (e) {
          // The pass couldn't be made: put the money back before reporting the error.
          await prisma.wallet.update({ where: { userId: user.id }, data: { balance: { increment: price } } });
          throw e;
        }
        offers.clear();
        const pass = await passFor(user.id, matchId);
        return { status: 'paid' as const, reference: pass!.id.toUpperCase() };
      }
      return startCheckout({ kind: 'pass', user, refId: matchId, amount: price, currency: o.currency, method: b.paidWith, title: 'Match pass' });
    });
  });

  // -------------------------------------------------------- donations
  // A gift to a donation stream. Signed in: from the wallet or by payment. Signed out: by payment,
  // with an email for the receipt. Shown on the thank-you list unless anonymous.
  app.post<{ Params: { id: string } }>('/matches/:id/donations', async (req) => {
    const b = z.object({ amount: z.number().int().positive(), paidWith: z.union([z.literal('wallet'), METHOD]), name: z.string().trim().max(60).optional(), anonymous: z.boolean().optional(), message: z.string().trim().max(140).optional(), email: z.string().trim().max(120).optional() }).parse(req.body);
    const o = await prisma.passOffer.findUnique({ where: { matchId: req.params.id } });
    if (!o || o.mode !== 'donation') throw notFound('Donation stream');
    const currency = o.currency as FinanceCurrency;
    const min = minimumDonation(currency);
    if (b.amount < min) throw badRequest(`The smallest gift is ${formatMoney(min, currency)}`);
    const user = req.user;
    const name = b.name || user?.name || 'A supporter';
    const meta = { name, anonymous: !!b.anonymous, message: b.message, email: user ? undefined : b.email };
    if (!user) {
      if (!b.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(b.email)) throw badRequest('Add your email for the receipt');
      if (b.paidWith === 'wallet') throw badRequest('Sign in to give from your wallet');
      // A guest checkout: no account, just the email for the receipt.
      return startCheckout({ kind: 'donation', user: { id: 'guest', name, email: b.email.toLowerCase() } as User, refId: o.matchId, amount: b.amount, currency, method: b.paidWith, title: 'Stream donation', meta });
    }
    if (b.paidWith === 'wallet') {
      const wc = await walletCurrency(user.id);
      if (wc !== currency) throw conflict(`This stream takes ${currency} and your wallet is in ${wc}. Pay by card instead; your bank converts it.`);
      const taken = await prisma.wallet.updateMany({ where: { userId: user.id, balance: { gte: b.amount } }, data: { balance: { decrement: b.amount } } });
      if (!taken.count) throw conflict('Not enough in your wallet. Top it up, or pay by card or transfer.');
      const reference = `GIFT-${newId('x').slice(-6).toUpperCase()}`;
      try {
        await prisma.walletEntry.create({ data: { id: newId('w'), userId: user.id, kind: 'donation', amount: -b.amount, note: 'Stream donation', reference } });
        await recordDonation({ matchId: o.matchId, userId: user.id, donorName: name, anonymous: !!b.anonymous, message: b.message, amount: b.amount, currency, paidWith: 'wallet' });
      } catch (e) {
        await prisma.wallet.update({ where: { userId: user.id }, data: { balance: { increment: b.amount } } });
        throw e;
      }
      return { status: 'paid' as const, reference };
    }
    return startCheckout({ kind: 'donation', user, refId: o.matchId, amount: b.amount, currency, method: b.paidWith, title: 'Stream donation', meta });
  });

  // -------------------------------------------------------- host earnings
  app.get('/me/earnings', async (req): Promise<HostEarnings> => {
    const user = requireUser(req);
    const [sales, payouts, balances] = await Promise.all([prisma.passSale.findMany({ where: { hostUserId: user.id }, orderBy: { at: 'desc' } }), prisma.hostPayout.findMany({ where: { userId: user.id }, orderBy: { at: 'desc' }, take: 50 }), hostBalances(user.id)]);
    // Hosts are paid in the currency of the passes they sell: their latest match's.
    const currency = (sales[0]?.currency as FinanceCurrency | undefined) ?? currencyForCountry(user.country);
    return {
      // What the host keeps of each pass after the payment fee, at today's rate. Failed payouts are
      // listed but don't count against the balance: the money came back.
      currency, share: Math.round((1 - (await platformShareFor(user.id))) * 1000) / 1000, balance: balances.get(currency) ?? 0, minimumPayout: hostPayoutMinimum(currency), nextPayoutOn: nextHostPayout(new Date()).toISOString(),
      matches: sales.map((x) => ({ matchId: x.matchId, passes: x.passes, donations: x.donations, gross: x.gross, fees: x.fees, host: x.host, at: x.at.toISOString() })),
      payouts: payouts.map((x) => ({ id: x.id, amount: x.amount, status: x.status as HostEarnings['payouts'][number]['status'], reference: x.reference, at: (x.paidAt ?? x.at).toISOString(), ...(x.accountLabel ? { accountLabel: x.accountLabel } : {}) })),
    };
  });

  // -------------------------------------------------------- viewer credits
  app.get<{ Params: { id: string } }>('/organisations/:id/viewer-credits', async (req): Promise<ViewerCredits> => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only league admins can see viewer credits');
    const o = await prisma.organisation.findUnique({ where: { id: req.params.id }, select: { viewerHoursLeft: true, viewerHoursUsed: true } });
    if (!o) throw notFound('Organisation');
    const purchases = await prisma.viewerCreditPurchase.findMany({ where: { orgId: req.params.id }, orderBy: { at: 'desc' } });
    return { orgId: req.params.id, hoursLeft: o.viewerHoursLeft, hoursUsed: o.viewerHoursUsed, purchases: purchases.map((p) => ({ id: p.id, hours: p.hours, price: p.price, reference: p.reference, at: p.at.toISOString() })) };
  });

  app.post<{ Params: { id: string } }>('/organisations/:id/viewer-credits', async (req) => {
    const user = requireUser(req);
    const b = z.object({ packs: z.number().int().min(1).max(50), method: METHOD }).parse(req.body);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only a league admin can buy viewer credits');
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id }, select: { currency: true } });
    const currency = (org?.currency ?? 'USD') as FinanceCurrency;
    return startCheckout({ kind: 'credits', user, refId: req.params.id, amount: b.packs * viewerCreditPackPrice(currency), currency, method: b.method, title: 'Ovalcast viewer credits', meta: { packs: b.packs } });
  });
}

