// Ovalcast's shares, set by staff rather than in code:
//   platformShare: of a paid stream's takings after the payment fee (default 25%); the streamer
//                  keeps the rest. A streamer's own rate wins, then their organisation's, then this.
//   entryShare:    of league entry fees paid online (default 2%). An organisation's own rate wins.
// Both are in the settings table. Each sale stores the rate it used, so a change never alters past
// sales. Every change is logged as a staff action.

import { DEFAULT_ENTRY_SHARE, DEFAULT_PLATFORM_SHARE, validShare } from '@/engine';
import type { User } from '@/api/types';
import { json, prisma, toJson } from '~/db/client';
import { emit, on } from './bus';
import { TtlCache, registerCache } from './cache';
import { badRequest, notFound } from './errors';
import { logStaff } from './staffLog';

export interface Shares {
  platformShare: number;
  entryShare: number;
  updatedAt?: string;
  updatedBy?: string;
}

const KEYS = { platformShare: 'platformShare', entryShare: 'entryShare' } as const;
const cache = registerCache(new TtlCache<Shares>(1));
on('shares:changed', () => cache.clear());

/** The global rates, cached for a few seconds. */
export function globalShares(): Promise<Shares> {
  return cache.remember('shares', 5000, async () => {
    const rows = await prisma.setting.findMany({ where: { key: { in: Object.values(KEYS) } } });
    const get = (k: string, d: number) => {
      const v = json<{ value?: number } | null>(rows.find((r) => r.key === k)?.value)?.value;
      return typeof v === 'number' && validShare(v) ? v : d;
    };
    const last = rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return { platformShare: get(KEYS.platformShare, DEFAULT_PLATFORM_SHARE), entryShare: get(KEYS.entryShare, DEFAULT_ENTRY_SHARE), updatedAt: last?.updatedAt.toISOString(), updatedBy: last?.updatedBy ?? undefined };
  });
}

/** The platform share for a pass on this streamer's stream of a match in this organisation (if any). */
export async function platformShareFor(hostUserId: string, orgId?: string | null): Promise<number> {
  const host = await prisma.user.findUnique({ where: { id: hostUserId }, select: { platformShare: true } });
  if (host?.platformShare != null) return host.platformShare;
  if (orgId) {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { platformShare: true } });
    if (org?.platformShare != null) return org.platformShare;
  }
  return (await globalShares()).platformShare;
}

/** Ovalcast's share of this organisation's entry fees. */
export async function entryShareFor(orgId: string): Promise<number> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { entryShare: true } });
  return org?.entryShare ?? (await globalShares()).entryShare;
}

const check = (n: number | null, what: string) => {
  if (n !== null && !validShare(n)) throw badRequest(`${what} must be between 0 and 90%, to a tenth of a percent`);
};
const pct = (n: number | null) => (n === null ? 'the default' : `${Math.round(n * 1000) / 10}%`);

/** Staff: the global rates. */
export async function setGlobalShares(staff: User, next: { platformShare?: number; entryShare?: number }) {
  const before = await globalShares();
  for (const [key, value] of Object.entries(next) as [keyof typeof KEYS, number | undefined][]) {
    if (value === undefined) continue;
    check(value, key === 'platformShare' ? 'The platform share' : 'The entry share');
    if (value === before[key]) continue;
    await prisma.setting.upsert({ where: { key: KEYS[key] }, create: { key: KEYS[key], value: toJson({ value }), updatedBy: staff.id }, update: { value: toJson({ value }), updatedBy: staff.id } });
    await logStaff(staff, 'setShare', 'settings', key, `${key === 'platformShare' ? 'Platform share' : 'Entry share'} ${pct(before[key])} → ${pct(value)}`);
  }
  emit('shares:changed', null);
  return globalShares();
}

/** Staff: an organisation's own rates (null goes back to the global setting). */
export async function setOrganisationShares(staff: User, orgId: string, next: { platformShare?: number | null; entryShare?: number | null }) {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { platformShare: true, entryShare: true } });
  if (!org) throw notFound('Organisation');
  if (next.platformShare !== undefined) check(next.platformShare, 'The platform share');
  if (next.entryShare !== undefined) check(next.entryShare, 'The entry share');
  const saved = await prisma.organisation.update({ where: { id: orgId }, data: { ...(next.platformShare !== undefined ? { platformShare: next.platformShare } : {}), ...(next.entryShare !== undefined ? { entryShare: next.entryShare } : {}) }, select: { platformShare: true, entryShare: true } });
  if (next.platformShare !== undefined && next.platformShare !== org.platformShare) await logStaff(staff, 'setShare', 'organisation', orgId, `Platform share ${pct(org.platformShare)} → ${pct(next.platformShare)}`);
  if (next.entryShare !== undefined && next.entryShare !== org.entryShare) await logStaff(staff, 'setShare', 'organisation', orgId, `Entry share ${pct(org.entryShare)} → ${pct(next.entryShare)}`);
  emit('shares:changed', null);
  return { platformShare: saved.platformShare, entryShare: saved.entryShare };
}

/** Staff: a streamer's own platform share (null goes back to their organisation's or the global one). */
export async function setStreamerShare(staff: User, userId: string, platformShare: number | null) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { platformShare: true } });
  if (!u) throw notFound('Person');
  check(platformShare, 'The platform share');
  await prisma.user.update({ where: { id: userId }, data: { platformShare } });
  if (platformShare !== u.platformShare) await logStaff(staff, 'setShare', 'user', userId, `Platform share ${pct(u.platformShare)} → ${pct(platformShare)}`);
  emit('shares:changed', null);
  return { platformShare };
}
