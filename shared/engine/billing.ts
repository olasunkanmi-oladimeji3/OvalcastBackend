// The business model, as rules the app and the server share: plans and their
// limits, Pro prices by country, match pass prices and the host's share, host
// payouts and viewer credits. Figures are from the PRD's Business model section.

import { localPrice } from './countries';
import { providerFee, type FinanceCurrency, type FinanceMethod } from './finance';

export type PlanId = 'free' | 'pro' | 'organisation';
export type BillingInterval = 'monthly' | 'yearly';

export interface PlanLimits {
  /** Leagues taking entries or in progress at the same time. */
  activeLeagues: number;
  teamsPerLeague: number;
  matchesPerMonth: number;
}

/** Organisation limits are agreed per contract; Infinity here. */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { activeLeagues: 1, teamsPerLeague: 8, matchesPerMonth: 10 },
  pro: { activeLeagues: 3, teamsPerLeague: 16, matchesPerMonth: 50 },
  organisation: { activeLeagues: Infinity, teamsPerLeague: Infinity, matchesPerMonth: Infinity },
};

/** What each plan unlocks beyond the limits. */
export const PLAN_FEATURES: Record<PlanId, { proAnalysis: boolean; adFree: boolean; rulesDocument: boolean; sellPasses: boolean; entryFeeCollection: boolean; api: boolean; multiDivision: boolean }> = {
  free: { proAnalysis: false, adFree: false, rulesDocument: false, sellPasses: false, entryFeeCollection: false, api: false, multiDivision: false },
  pro: { proAnalysis: true, adFree: true, rulesDocument: true, sellPasses: true, entryFeeCollection: false, api: false, multiDivision: false },
  organisation: { proAnalysis: true, adFree: true, rulesDocument: true, sellPasses: true, entryFeeCollection: true, api: true, multiDivision: true },
};

export type PriceCurrency = FinanceCurrency;

/** Pro is ₦1,500 a month in Nigeria and $3 a month everywhere else; a year costs ten months. */
export function proPrice(country?: string): { currency: PriceCurrency; monthly: number; yearly: number } {
  return country === 'Nigeria' ? { currency: 'NGN', monthly: 1500, yearly: 15000 } : { currency: 'USD', monthly: 3, yearly: 30 };
}

export function renewsOn(from: Date, interval: BillingInterval): Date {
  const d = new Date(from);
  if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

// ---------------------------------------------------------------- match passes

/**
 * Hosts set the price, at least about ₦350 per hour of scheduled play: ₦500 for T10,
 * ₦1,000 for T20, ₦2,500 for 50 overs, or the same value in the match's currency.
 */
export function minimumPassPrice(oversPerInnings: number, currency: FinanceCurrency = 'NGN'): number {
  return localPrice(oversPerInnings <= 10 ? 500 : oversPerInnings <= 20 ? 1000 : 2500, currency);
}

/** The price steps a host picks from, starting at the minimum. */
export function passPriceOptions(oversPerInnings: number, currency: FinanceCurrency = 'NGN'): number[] {
  const min = minimumPassPrice(oversPerInnings, currency);
  return [min, localPrice(oversPerInnings <= 10 ? 1000 : oversPerInnings <= 20 ? 1500 : 3500, currency), localPrice(oversPerInnings <= 10 ? 1500 : oversPerInnings <= 20 ? 2500 : 5000, currency)].filter((v, i, a) => a.indexOf(v) === i && v >= min);
}

/**
 * Ovalcast's share of a paid stream's takings, after the payment fee, unless staff set another (for
 * everyone, an organisation or a streamer). The streamer keeps the rest. Free streams carry none.
 */
export const DEFAULT_PLATFORM_SHARE = 0.25;

/** A share as staff may set it: 0 to 90%, to a tenth of a percent. */
export const validShare = (n: number) => Number.isFinite(n) && n >= 0 && n <= 0.9 && Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-9;

/**
 * How one pass payment divides: the payment fee first, then the platform share of what's left, and
 * the streamer keeps the rest, so the parts always add up to the price. Wallet payments carry no
 * payment fee: the top-up paid it.
 */
export function splitPass(price: number, currency: FinanceCurrency, platformShare: number, paidWith: FinanceMethod | 'wallet', international = false) {
  const fee = paidWith === 'wallet' ? 0 : providerFee(price, currency, paidWith, international);
  const net = price - fee;
  const platform = Math.round(net * platformShare);
  return { gross: price, providerFee: fee, platform, host: net - platform };
}

/** Host earnings are paid weekly once the balance reaches ₦5,000, or the same value locally; smaller balances roll over. */
export const HOST_PAYOUT_MINIMUM = 5000;
export const hostPayoutMinimum = (currency: FinanceCurrency = 'NGN') => localPrice(HOST_PAYOUT_MINIMUM, currency);

/** Monday 09:00 UTC after `from`: when weekly host payouts run. */
export function nextHostPayout(from: Date): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 9));
  do d.setTime(d.getTime() + 86_400_000);
  while (d.getUTCDay() !== 1);
  return d;
}

/** Viewers are refunded when the stream was down for more than about 30% of the match. */
export const refundDue = (downSeconds: number, matchSeconds: number) => matchSeconds > 0 && downSeconds / matchSeconds > 0.3;

// ------------------------------------------------------------- viewer credits

/** Organisers buy viewer-hours so fans watch free in the Ovalcast player: ₦12,000 per 100, or the same value locally. */
export const VIEWER_CREDIT_PACK = { viewerHours: 100, price: 12000 } as const;
export const viewerCreditPackPrice = (currency: FinanceCurrency = 'NGN') => localPrice(VIEWER_CREDIT_PACK.price, currency);

/** Wallet top-ups, so fans avoid a payment fee on every pass: ₦1,000 to ₦10,000, or the same values locally. */
export const WALLET_TOP_UPS = [1000, 2500, 5000, 10000] as const;
export const walletTopUps = (currency: FinanceCurrency = 'NGN') => [...new Set(WALLET_TOP_UPS.map((n) => localPrice(n, currency)))];
