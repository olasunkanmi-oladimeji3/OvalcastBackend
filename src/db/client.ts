import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

/**
 * The connection, with the database's own certificate when it isn't one Node trusts already.
 * Hosted Postgres such as Supabase signs its certificate with its own authority: set
 * DATABASE_CA_CERT to that certificate (its PEM text, or a path to the file) and the connection is
 * encrypted and fully checked. Without it, the URL's own sslmode applies.
 */
export function connection(url: string, env = process.env): { connectionString: string; ssl?: { ca: string; rejectUnauthorized: true } } {
  const ca = env.DATABASE_CA_CERT?.trim();
  if (!ca) return { connectionString: url };
  const u = new URL(url);
  // sslmode in the URL would replace the certificate below, so it's left out.
  u.searchParams.delete('sslmode');
  return { connectionString: u.toString(), ssl: { ca: ca.includes('BEGIN CERTIFICATE') ? ca.replace(/\\n/g, '\n') : readFileSync(ca, 'utf8'), rejectUnauthorized: true } };
}

// The session runs in UTC: the adapter reads timestamptz values without their offset, so any other zone shifts every date.
// DB_POOL_MAX is the most connections the server opens in total. Keep it under the database's limit,
// counting other servers, or point DATABASE_URL at a pooler (Neon's -pooler host, PgBouncer).
// With several processes (WEB_CONCURRENCY) the connections are shared out between them, so the
// total stays at DB_POOL_MAX; going over the database's limit refuses connections to everyone.
const processes = Math.max(1, Number(process.env.OVALCAST_PROCESSES ?? 1));
const poolSize = Math.max(2, Math.floor(Number(process.env.DB_POOL_MAX ?? 20) / processes));
const adapter = new PrismaPg({ ...connection(process.env.DATABASE_URL!), options: '-c TimeZone=UTC', max: poolSize, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
export const prisma = new PrismaClient({ adapter });
export { Prisma };

/** Reads a Json column as its contract type (shapes are defined in mobile/src/api/types.ts). */
export const json = <T,>(v: Prisma.JsonValue | null | undefined) => v as unknown as T;
/** A value for a Json column. Missing values become SQL NULL (only ever passed to nullable columns). */
export const toJson = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : v) as Prisma.InputJsonValue;
/** A unique-constraint violation, such as a retried ball with the same client id. */
export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
