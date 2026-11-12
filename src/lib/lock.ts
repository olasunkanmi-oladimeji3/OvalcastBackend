// Background work that must run on one machine at a time (paying streamers, sending partner
// webhooks). Each server machine runs the same timers, so the database decides: whoever takes
// the lock runs, the others skip this round. The lock is released when the work ends, or if the
// machine running it dies (it's held by a transaction).

import { prisma } from '~/db/client';

export async function withLock<T>(name: string, work: () => Promise<T>, maxMs = 10 * 60_000): Promise<T | undefined> {
  return prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${name})) as locked`;
      return locked ? work() : undefined;
    },
    { timeout: maxMs, maxWait: 10_000 },
  );
}

/**
 * Runs `work` with nobody else running work under the same key at the same time, on any server
 * process: the second caller waits for the first to finish, then sees what it did. For a
 * check-then-change that must not happen twice at once (a double tap on "buy", two withdrawals,
 * two clubs accepted into the last place). The lock is a Postgres advisory lock held by a
 * transaction, so it's released when the work ends, or if this process dies.
 */
export async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${key}))`;
      return work();
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}
