// Which features cost money, decided by Ovalcast staff, not fixed in code.
// Ovalcast launches free so the community can grow; staff switch on payment
// for individual features later from the staff console, and the app, the
// website and the server all read the same setting.

import { PLAN_FEATURES, PLAN_LIMITS, type PlanId, type PlanLimits } from './billing';

export type PaidFeature = keyof (typeof PLAN_FEATURES)['free'];

export const PAID_FEATURES: { key: PaidFeature; label: string; sub: string }[] = [
  { key: 'proAnalysis', label: 'Player and team analysis', sub: 'Form, phase splits, matchups and scoring zones' },
  { key: 'rulesDocument', label: 'Rules documents', sub: 'Uploading a competition’s rules for everyone to read' },
  { key: 'sellPasses', label: 'Selling match passes', sub: 'Hosts charging fans to watch a stream' },
  { key: 'entryFeeCollection', label: 'Online entry fees', sub: 'Clubs paying entry fees through Flutterwave' },
  { key: 'multiDivision', label: 'Several divisions', sub: 'Promotion, relegation and season rollover' },
  { key: 'api', label: 'Website and API', sub: 'Keys, webhooks and embeds for a client’s own site' },
  { key: 'adFree', label: 'No ads', sub: 'Only matters once there are ads' },
];

/** The cheapest plan that unlocks a feature, or free for everyone. */
export type AccessLevel = 'free' | 'pro' | 'organisation';

export interface FeatureAccess {
  requires: Record<PaidFeature, AccessLevel>;
  /** Plan limits (leagues at once, teams a league, matches a month). Off: no limits at all. */
  limitsEnforced: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/** Launch setting: everything free, no limits. */
export const FREE_FOR_ALL: FeatureAccess = {
  requires: { proAnalysis: 'free', adFree: 'free', rulesDocument: 'free', sellPasses: 'free', entryFeeCollection: 'free', api: 'free', multiDivision: 'free' },
  limitsEnforced: false,
};

/** The original business model, for staff to switch to in one go. */
export const PRD_PRICING: FeatureAccess = {
  requires: { proAnalysis: 'pro', adFree: 'pro', rulesDocument: 'pro', sellPasses: 'pro', entryFeeCollection: 'organisation', api: 'organisation', multiDivision: 'organisation' },
  limitsEnforced: true,
};

const RANK: Record<PlanId, number> = { free: 0, pro: 1, organisation: 2 };

/** Whether someone on this plan may use the feature under the current setting. */
export const featureAllowed = (access: FeatureAccess, feature: PaidFeature, plan: PlanId) => RANK[plan] >= RANK[access.requires[feature] ?? 'free'];

/** A plan's limits under the current setting: none at all while limits are off. */
export const limitsFor = (access: FeatureAccess, plan: PlanId): PlanLimits =>
  access.limitsEnforced ? PLAN_LIMITS[plan] : { activeLeagues: Infinity, teamsPerLeague: Infinity, matchesPerMonth: Infinity };

/** Nothing costs anything: the app hides Pro and plan talk. */
export const everythingFree = (access: FeatureAccess) => !access.limitsEnforced && Object.values(access.requires).every((r) => r === 'free');

/** The plan someone needs for a feature, in words, for a 402 message. */
export const needsPlan = (access: FeatureAccess, feature: PaidFeature) => (access.requires[feature] === 'organisation' ? 'the Organisation plan' : 'Pro');
