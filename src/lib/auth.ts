import type { FastifyRequest } from 'fastify';
import type { User } from '@/api/types';
import { prisma } from '~/db/client';
import { sha256 } from './crypto';
import { on } from './bus';
import { TtlCache, registerCache } from './cache';
import { ApiError } from './errors';
import { loadUser } from './repo';

// Who's asking, held for a short while: otherwise every signed-in request costs three reads
// before it starts. Any change anywhere (sign-out, a new role, a profile edit) drops it all.
const sessions = registerCache(new TtlCache<{ userId: string; expiresAt: number } | null>(20000));
const users = registerCache(new TtlCache<User | null>(20000));
on('responses:clear', () => {
  sessions.clear();
  users.clear();
});

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, when a valid Bearer token was sent. */
    user?: User;
    sessionHash?: string;
  }
}

/** Reads the Bearer token, if any, and attaches the user. Runs on every request. */
export async function attachUser(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return;
  const tokenHash = sha256(header.slice(7));
  const s = await sessions.remember(tokenHash, 60_000, async () => {
    // A suspended account's sessions are ended when it's suspended; this catches any made since.
    const row = await prisma.session.findFirst({ where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() }, user: { suspendedAt: null } }, select: { userId: true, expiresAt: true } });
    return row ? { userId: row.userId, expiresAt: row.expiresAt.getTime() } : null;
  });
  if (!s || s.expiresAt < Date.now()) return;
  const u = await users.remember(s.userId, 30_000, async () => (await loadUser(s.userId)) ?? null);
  if (!u) return;
  // Each request gets its own copy, so a handler changing it can't affect another.
  req.user = structuredClone(u);
  req.sessionHash = tokenHash;
  seen(u.id);
}

// When each account was last active, for the backoffice: written at most every five minutes per account.
const lastWrite = new Map<string, number>();
function seen(userId: string) {
  const now = Date.now();
  if (now - (lastWrite.get(userId) ?? 0) < 5 * 60_000) return;
  lastWrite.set(userId, now);
  if (lastWrite.size > 50_000) lastWrite.clear();
  void prisma.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
}

/** Ovalcast's own staff: the backoffice and staff console. */
export function requireStaff(req: FastifyRequest): User {
  const user = requireUser(req);
  if (!user.staff) throw new ApiError(403, 'Ovalcast staff only');
  return user;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new ApiError(401, 'Sign in to do that');
  return req.user;
}
