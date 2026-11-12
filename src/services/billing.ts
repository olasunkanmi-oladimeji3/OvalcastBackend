// The business model on the server: which plan applies, the limits, and the
// one checkout every payment goes through. A checkout is completed once, from
// Flutterwave's verified webhook (or at once in development), and only then
// is anything given: Pro, a wallet top-up, a pass, viewer credits or a paid entry.

import type { Payment, User } from '@/api/types';
import { currencyForCountry, formatMoney, refundDue, type PaidFeature, renewsOn, splitPass, VIEWER_CREDIT_PACK, type BillingInterval, type FinanceCurrency, type PlanId } from '@/engine';
import { json, prisma, toJson } from '~/db/client';
import { requestOrigin } from '~/lib/requestContext';
import { ApiError } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { payInstantly, payments } from '~/lib/payments';
import { notify } from '~/lib/repo';
import { allows, limitsOf, planNeededFor } from './access';
import { on } from '~/lib/bus';
import { TtlCache, registerCache } from '~/lib/cache';
import { platformShareFor } from '~/lib/shares';

export type CheckoutKind = 'entry' | 'pro' | 'topUp' | 'pass' | 'credits';

// ------------------------------------------------------------------ plans

export async function userPlan(userId: string, now = new Date()): Promise<PlanId> {
  const sub = await prisma.subscription.findFirst({ where: { userId, status: { not: 'cancelled' }, renewsAt: { gt: now } } });
  return sub ? 'pro' : 'free';
}

/** A league runs on its organisation's contract, or on the best plan among the admins who run it. */
export async function leaguePlan(orgId: string): Promise<PlanId> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { plan: true } });
  if (org?.plan === 'organisation') return 'organisation';
  const admins = await prisma.membership.findMany({ where: { orgId, role: { in: ['leagueAdmin', 'owner'] } }, select: { userId: true } });
  for (const a of admins) if ((await userPlan(a.userId)) === 'pro') return 'pro';
  return 'free';
}

const PLAN_NAME: Record<PlanId, string> = { free: 'Free', pro: 'Pro', organisation: 'Organisation' };
const upgradeHint = (plan: PlanId) => (plan === 'free' ? ' Upgrade to Pro for more.' : plan === 'pro' ? ' Talk to Ovalcast about the Organisation plan for more.' : '');

/** 402 with a plain reason when a plan limit is reached. */
export const limitReached = (message: string, plan: PlanId) => new ApiError(402, `${message}${upgradeHint(plan)}`);

export async function checkNewLeague(orgId: string, maxTeams: number) {
  const plan = await leaguePlan(orgId);
  const lim = await limitsOf(plan);
  const active = await prisma.competition.count({ where: { orgId, status: { not: 'completed' } } });
  if (active >= lim.activeLeagues) throw limitReached(`The ${PLAN_NAME[plan]} plan runs ${lim.activeLeagues} league${lim.activeLeagues === 1 ? '' : 's'} at a time.`, plan);
  if (maxTeams > lim.teamsPerLeague) throw limitReached(`The ${PLAN_NAME[plan]} plan allows up to ${lim.teamsPerLeague} teams a league.`, plan);
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Friendlies count against the scorer's plan; league matches against the league's. */
export async function matchesThisMonth(scope: { orgId?: string; scorerUserId?: string }) {
  const since = monthStart();
  if (scope.orgId) return prisma.match.count({ where: { startedAt: { gte: since }, competition: { orgId: scope.orgId } } });
  return prisma.match.count({ where: { startedAt: { gte: since }, competitionId: null, scorerUserId: scope.scorerUserId } });
}

export async function checkMatchStart(competitionOrgId: string | undefined, scorerUserId: string) {
  const plan = competitionOrgId ? await leaguePlan(competitionOrgId) : await userPlan(scorerUserId);
  const cap = (await limitsOf(plan)).matchesPerMonth;
  if (!Number.isFinite(cap)) return;
  const used = await matchesThisMonth(competitionOrgId ? { orgId: competitionOrgId } : { scorerUserId });
  if (used >= cap) throw limitReached(`${competitionOrgId ? 'This league has' : 'You have'} scored ${cap} matches this month, the ${PLAN_NAME[plan]} plan's limit.`, plan);
}

/** Throws 402 when the staff setting puts this feature on a plan the league isn't on. Free for everyone at launch. */
export async function requireFeature(orgId: string, feature: PaidFeature, what: string) {
  if (!(await allows(feature, await leaguePlan(orgId)))) throw new ApiError(402, `${what} needs ${await planNeededFor(feature)}.`);
}

/** Who may sell passes: anyone whose plan allows it, or a league admin whose league's plan does. */
export async function canHost(user: User, m: { competitionId: string | null }) {
  if (await allows('sellPasses', await userPlan(user.id))) return true;
  if (!m.competitionId) return false;
  const c = await prisma.competition.findUnique({ where: { id: m.competitionId }, select: { orgId: true } });
  return !!c && user.memberships.some((x) => x.orgId === c.orgId && (x.role === 'leagueAdmin' || x.role === 'owner')) && (await allows('sellPasses', await leaguePlan(c.orgId)));
}

// ---------------------------------------------------------------- checkout

export interface StartCheckout {
  kind: CheckoutKind;
  user: User;
  refId?: string;
  amount: number;
  currency: string;
  method: string;
  title: string;
  meta?: Record<string, unknown>;
  subaccount?: { id: string; serviceFee: number };
}

/** Starts a payment. Development completes it at once; production returns Flutterwave's checkout link. */
export async function startCheckout(c: StartCheckout): Promise<{ status: 'paid' | 'redirect'; reference: string; link?: string }> {
  const id = `ovl_${c.kind}_${newId('x').slice(2)}`;
  await prisma.checkout.create({ data: { id, kind: c.kind, userId: c.user.id, refId: c.refId ?? null, amount: c.amount, currency: c.currency, status: 'pending', meta: toJson(c.meta ?? {}), method: c.method } });
  if (payInstantly()) {
    await completeCheckout(id, { providerId: `dev_${Date.now()}`, paymentType: c.method === 'mobileMoney' ? 'mobilemoneygh' : c.method, international: false });
    return { status: 'paid', reference: `FLW-${id.slice(-8).toUpperCase()}` };
  }
  const { link } = await payments().checkout({ txRef: id, amount: c.amount, currency: c.currency, customer: { email: c.user.email, phone: c.user.phone, name: c.user.name }, title: c.title, subaccount: c.subaccount, redirectUrl: `${returnUrl()}?ref=${id}` });
  return { status: 'redirect', reference: id, link };
}

/** Applies a paid checkout. Safe to call twice: only the first call changes anything. */
export async function completeCheckout(id: string, charge: { providerId: string; paymentType: string; international: boolean }) {
  const claimed = await prisma.checkout.updateMany({ where: { id, status: 'pending' }, data: { status: 'paid', paidAt: new Date(), providerId: charge.providerId } });
  if (!claimed.count) return;
  const c = await prisma.checkout.findUniqueOrThrow({ where: { id } });
  const meta = json<Record<string, unknown>>(c.meta);
  const reference = `FLW-${id.slice(-8).toUpperCase()}`;
  const now = new Date();

  if (c.kind === 'pro') {
    const interval = meta.interval as BillingInterval;
    const current = await prisma.subscription.findFirst({ where: { userId: c.userId, status: { not: 'cancelled' } }, orderBy: { renewsAt: 'desc' } });
    // A renewal extends from the current end; a new subscription starts now.
    const from = current && current.renewsAt > now ? current.renewsAt : now;
    if (current) await prisma.subscription.update({ where: { id: current.id }, data: { status: 'active', interval, amount: c.amount, currency: c.currency, renewsAt: renewsOn(from, interval), cancelAtPeriodEnd: false } });
    else await prisma.subscription.create({ data: { id: newId('sub'), userId: c.userId, plan: 'pro', interval, status: 'active', currency: c.currency, amount: c.amount, startedAt: now, renewsAt: renewsOn(now, interval), provider: 'flutterwave' } });
    await notify(c.userId, { kind: 'payment', title: 'Welcome to Ovalcast Pro', body: `Reference ${reference}. Pro analysis, higher limits and paid streams are on.`, link: { pathname: '/plans' } });
  }

  if (c.kind === 'topUp') {
    await prisma.$transaction([
      prisma.wallet.upsert({ where: { userId: c.userId }, create: { userId: c.userId, balance: c.amount, currency: c.currency }, update: { balance: { increment: c.amount } } }),
      prisma.walletEntry.create({ data: { id: newId('w'), userId: c.userId, kind: 'topUp', amount: c.amount, note: 'Top-up', reference } }),
    ]);
  }

  if (c.kind === 'pass') {
    // Paid twice for the same match (a double tap, or two tabs): one pass, and the second payment goes back.
    if (await passFor(c.userId, c.refId!)) await giveBack(c.id, c.userId, c.amount, c.currency, 'You already had a pass for this match');
    else await issuePass({ userId: c.userId, matchId: c.refId!, price: c.amount, currency: c.currency, paidWith: methodName(charge.paymentType), international: charge.international });
  }

  if (c.kind === 'credits') {
    const hours = Number(meta.packs) * VIEWER_CREDIT_PACK.viewerHours;
    await prisma.$transaction([
      prisma.organisation.update({ where: { id: c.refId! }, data: { viewerHoursLeft: { increment: hours } } }),
      prisma.viewerCreditPurchase.create({ data: { id: newId('vc'), orgId: c.refId!, hours, price: c.amount, reference } }),
    ]);
  }

  if (c.kind === 'entry') {
    const e = await prisma.entry.findUniqueOrThrow({ where: { id: c.refId! }, include: { competition: { include: { org: true } } } });
    const payment: Payment = { id: newId('pay'), entryId: e.id, amount: c.amount, currency: e.competition.org.currency as Payment['currency'], method: methodName(charge.paymentType), provider: 'flutterwave', reference, status: 'paid', at: now.toISOString(), international: charge.international || undefined, serviceRate: typeof meta.serviceRate === 'number' ? meta.serviceRate : undefined };
    await prisma.entry.update({ where: { id: e.id }, data: { payment: toJson(payment) } });
    const admins = await prisma.membership.findMany({ where: { orgId: e.competition.orgId, role: { in: ['leagueAdmin', 'owner'] } }, select: { userId: true } });
    await notify(admins.map((a) => a.userId), { kind: 'payment', title: 'Entry fee paid', body: `${e.competition.name}. Reference ${reference}.`, link: { pathname: '/money/[orgId]', params: { orgId: e.competition.orgId } } });
  }
}

/**
 * Where Flutterwave sends the payer afterwards: the website's page when they paid from the
 * website (the request came from its address), otherwise the app.
 */
function returnUrl() {
  const origin = requestOrigin();
  const web = process.env.WEB_URL?.replace(/\/$/, '');
  if (origin && web && origin === web) return `${web}/payments/done`;
  return process.env.PAYMENT_RETURN_URL ?? 'ovalcast://payments/done';
}

const methodName = (paymentType: string): Payment['method'] =>
  paymentType === 'card' ? 'card' : paymentType === 'ussd' ? 'ussd' : paymentType.startsWith('mobilemoney') || paymentType === 'mobileMoney' ? 'mobileMoney' : 'bankTransfer';

// ------------------------------------------------------------------ passes

/**
 * Creates the pass and books the split: the payment fee (none from the wallet), the platform share
 * of the rest at today's rate for this streamer and organisation, and the streamer's share. The
 * pass keeps the rate it used, so a later change never alters it.
 */
export async function issuePass(p: { userId: string; matchId: string; price: number; currency: string; paidWith: Payment['method'] | 'wallet'; international?: boolean }) {
  const offer = await prisma.passOffer.findUniqueOrThrow({ where: { matchId: p.matchId } });
  const m = await prisma.match.findUniqueOrThrow({ where: { id: p.matchId }, select: { competition: { select: { orgId: true } } } });
  const platformShare = await platformShareFor(offer.hostUserId, m.competition?.orgId);
  const split = splitPass(p.price, p.currency as FinanceCurrency, platformShare, p.paidWith, p.international);
  await prisma.$transaction([
    prisma.matchPass.create({ data: { id: newId('pass'), userId: p.userId, matchId: p.matchId, competitionId: null, price: p.price, currency: p.currency, paidWith: p.paidWith, status: 'active', hostUserId: offer.hostUserId, fee: split.providerFee, hostShare: split.host, platformShare } }),
    prisma.passSale.upsert({
      where: { matchId_hostUserId: { matchId: p.matchId, hostUserId: offer.hostUserId } },
      create: { matchId: p.matchId, hostUserId: offer.hostUserId, passes: 1, gross: p.price, fees: split.providerFee, host: split.host, currency: p.currency },
      update: { passes: { increment: 1 }, gross: { increment: p.price }, fees: { increment: split.providerFee }, host: { increment: split.host } },
    }),
  ]);
}

/** The viewer's active pass for this match. Passes are per match: there are no season passes for streams. */
export async function passFor(userId: string | undefined, matchId: string) {
  if (!userId) return null;
  return prisma.matchPass.findFirst({ where: { userId, matchId, status: 'active' } });
}

/** True when the viewer may watch: free stream, the host, or a pass holder. */
// Watch pages check every few seconds; the answer only changes when someone pays, is refunded
// or a price is set, and any change (bus 'responses:clear') empties it.
const watchable = registerCache(new TtlCache<boolean>(50_000));
on('responses:clear', () => watchable.clear());

export function mayWatch(userId: string | undefined, matchId: string) {
  return watchable.remember(`${userId ?? ''}:${matchId}`, 30_000, () => mayWatchNow(userId, matchId));
}

async function mayWatchNow(userId: string | undefined, matchId: string) {
  const offer = await prisma.passOffer.findUnique({ where: { matchId } });
  if (!offer) return true;
  if (userId === offer.hostUserId) return true;
  return !!(await passFor(userId, matchId));
}


/** A user's wallet currency: fixed at the first top-up, otherwise the currency of where they play. */
export async function walletCurrency(userId: string) {
  const w = await prisma.wallet.findUnique({ where: { userId }, select: { currency: true } });
  if (w?.currency) return w.currency as FinanceCurrency;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
  return currencyForCountry(u?.country ?? undefined);
}

/**
 * Money going back to someone: into their wallet when it's paid from the wallet or in the wallet's
 * currency (instant, and no card fee either way), otherwise to the card or account through
 * Flutterwave. Returns where it went. A Flutterwave refund that fails is marked on the checkout
 * (status refundFailed) and logged, for staff to send by hand.
 */
async function giveBack(checkoutId: string | undefined, userId: string, amount: number, currency: string, reason: string, opts: { paidFromWallet?: boolean } = {}): Promise<'wallet' | 'card'> {
  const toWallet = opts.paidFromWallet || (await walletCurrency(userId)) === currency || !checkoutId;
  if (toWallet) {
    await prisma.$transaction([
      prisma.wallet.upsert({ where: { userId }, create: { userId, balance: amount, currency }, update: { balance: { increment: amount } } }),
      prisma.walletEntry.create({ data: { id: newId('w'), userId, kind: 'refund', amount, note: `Refund: ${reason}`, reference: `RF-${newId('x').slice(-6).toUpperCase()}` } }),
    ]);
    if (checkoutId) await prisma.checkout.update({ where: { id: checkoutId }, data: { status: 'refunded' } });
  } else {
    const c = await prisma.checkout.findUniqueOrThrow({ where: { id: checkoutId } });
    try {
      if (!c.providerId) throw new Error('no Flutterwave transaction id');
      await payments().refund({ transactionId: c.providerId, amount });
      await prisma.checkout.update({ where: { id: c.id }, data: { status: 'refunded' } });
    } catch (e) {
      console.error(`[refund] checkout ${c.id}: ${e instanceof Error ? e.message : e}`);
      await prisma.checkout.update({ where: { id: c.id }, data: { status: 'refundFailed' } });
    }
  }
  await notify(userId, { kind: 'payment', title: 'Payment refunded', body: `${reason}. ${formatMoney(amount, currency as FinanceCurrency)} is ${toWallet ? 'back in your wallet' : 'on its way back to your card or account (it can take a few days to show)'}.` });
  return toWallet ? 'wallet' : 'card';
}

/** The paid checkout behind a pass bought by card or transfer, to refund it to the same place. */
const checkoutForPass = (p: { userId: string; matchId: string | null; price: number }) =>
  prisma.checkout.findFirst({ where: { kind: 'pass', userId: p.userId, refId: p.matchId, status: 'paid', amount: p.price }, orderBy: { paidAt: 'desc' } });

/** Gives back every pass for a match, once each: to the wallet, or to the card through Flutterwave. */
export async function refundMatchPasses(matchId: string, reason: string) {
  const passes = await prisma.matchPass.findMany({ where: { matchId, status: 'active' } });
  let amount = 0;
  for (const p of passes) {
    // Claim it first, so two refunds running at once never give the same pass back twice.
    const claimed = await prisma.matchPass.updateMany({ where: { id: p.id, status: 'active' }, data: { status: 'refunded' } });
    if (!claimed.count) continue;
    const checkout = p.paidWith === 'wallet' ? null : await checkoutForPass(p);
    await giveBack(checkout?.id, p.userId, p.price, p.currency, reason, { paidFromWallet: p.paidWith === 'wallet' });
    amount += p.price;
  }
  await prisma.passSale.updateMany({ where: { matchId }, data: { passes: 0, gross: 0, fees: 0, host: 0 } });
  return { refunded: passes.length, amount };
}

/** Over 30% of a stream down: refund every pass for its match, once. */
export async function refundIfMostlyDown(streamId: string) {
  const s = await prisma.stream.findUnique({ where: { id: streamId } });
  if (!s || s.refundedAt || !refundDue(s.downSeconds, s.liveSeconds + s.downSeconds)) return false;
  await prisma.stream.update({ where: { id: s.id }, data: { refundedAt: new Date() } });
  const r = await refundMatchPasses(s.matchId, 'The stream was down for more than 30% of the match');
  const offer = await prisma.passOffer.findUnique({ where: { matchId: s.matchId } });
  if (offer && r.refunded) await notify(offer.hostUserId, { kind: 'payment', title: 'Passes refunded for a stream that dropped', body: `The stream was down for over 30% of the time, so ${r.refunded} viewer${r.refunded === 1 ? '' : 's'} got their money back. Nothing is paid out for this match.` });
  return true;
}
