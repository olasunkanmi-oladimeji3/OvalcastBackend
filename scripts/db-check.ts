// Checks the database in .env (or the environment) without changing anything:
//   npm run db:check
// Can it connect, with the certificate, from here? How fast? Is pg_trgm there? Which migrations
// are still to apply? Prints host names only, never a password.

import 'dotenv/config';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import { connection } from '../src/db/client';

const where = (url: string) => {
  const u = new URL(url);
  const pooled = u.port === '6543';
  return `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}${pooled ? ' (transaction pooler)' : ''}`;
};

async function check(label: string, url: string | undefined) {
  if (!url) return console.log(`${label}: not set`);
  const client = new pg.Client({ ...connection(url), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${label}: ${where(url)}\n  ✗ can't connect: ${msg}`);
    if (/certificate|self.signed/i.test(msg)) console.log('  Set DATABASE_CA_CERT to the database’s SSL certificate (Supabase: Project Settings, Database, SSL Configuration, Download certificate).');
    if (/password/i.test(msg)) console.log('  Check the password in the connection string (Supabase: Project Settings, Database, Reset database password).');
    process.exitCode = 1;
    return;
  }
  const times: number[] = [];
  for (let i = 0; i < 15; i++) {
    const t = performance.now();
    await client.query('select 1');
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const version = (await client.query<{ v: string }>("select current_setting('server_version') as v")).rows[0].v;
  // This end of the connection: through a pooler, the database only sees the pooler's own link.
  const ssl = !!(client as unknown as { connection?: { stream?: { encrypted?: boolean } } }).connection?.stream?.encrypted;
  console.log(`${label}: ${where(url)}\n  ✓ connected, Postgres ${version}, ${ssl ? 'encrypted' : 'NOT encrypted'}, round trip ${times[7].toFixed(0)} ms (p50), ${times[13].toFixed(0)} ms (p95)`);
  await client.end();
}

async function main() {
  await check('DATABASE_URL (the server)', process.env.DATABASE_URL);
  await check('DIRECT_DATABASE_URL (migrations)', process.env.DIRECT_DATABASE_URL);
  const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
  if (!url || process.exitCode) return;

  const client = new pg.Client(connection(url));
  await client.connect();
  const trgm = (await client.query<{ installed: string | null }>("select installed_version as installed from pg_available_extensions where name = 'pg_trgm'")).rows[0];
  console.log(trgm ? `pg_trgm: ${trgm.installed ? `installed (${trgm.installed})` : 'available; the first migration installs it'}` : 'pg_trgm: ✗ not available on this database (search needs it)');
  const folder = readdirSync('prisma/migrations', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const hasTable = (await client.query("select to_regclass('public._prisma_migrations') as t")).rows[0].t;
  const applied = hasTable ? (await client.query<{ migration_name: string }>('select migration_name from _prisma_migrations where finished_at is not null')).rows.map((r) => r.migration_name) : [];
  const pending = folder.filter((m) => !applied.includes(m));
  console.log(pending.length ? `Migrations: ${pending.length} of ${folder.length} to apply. Run npm run db:deploy.` : `Migrations: all ${folder.length} applied.`);
  await client.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
