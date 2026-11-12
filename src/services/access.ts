// Which features need a paid plan: one setting staff change from the console.
// Everything is free until they switch a feature on. Read on every check, but
// cached for a few seconds so busy routes don't hit the database each time.

import { FREE_FOR_ALL, featureAllowed, limitsFor, needsPlan, type FeatureAccess, type PaidFeature, type PlanId } from '@/engine';
import { json, prisma, toJson } from '~/db/client';
import { emit, on } from '~/lib/bus';
import { registerCache, TtlCache } from '~/lib/cache';

const KEY = 'featureAccess';
const cache = registerCache(new TtlCache<FeatureAccess>(1));
// A change made in another server process applies here at once too.
on('featureAccess:changed', () => cache.delete(KEY));

export function featureAccess(): Promise<FeatureAccess> {
  return cache.remember(KEY, 5000, async () => {
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    return row ? { ...FREE_FOR_ALL, ...json<FeatureAccess>(row.value), updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy ?? undefined } : FREE_FOR_ALL;
  });
}

export async function setFeatureAccess(value: FeatureAccess, by: string): Promise<FeatureAccess> {
  const clean = { requires: value.requires, limitsEnforced: value.limitsEnforced };
  await prisma.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: toJson(clean), updatedBy: by }, update: { value: toJson(clean), updatedBy: by } });
  emit('featureAccess:changed', null);
  return featureAccess();
}

export const allows = async (feature: PaidFeature, plan: PlanId) => featureAllowed(await featureAccess(), feature, plan);
export const limitsOf = async (plan: PlanId) => limitsFor(await featureAccess(), plan);
export const planNeededFor = async (feature: PaidFeature) => needsPlan(await featureAccess(), feature);
