import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx scripts/seed.ts',
  },
  // Migrations need a direct connection to the database (Supabase: the "Direct connection" or
  // "Session pooler" string), not the transaction pooler the server uses. DIRECT_DATABASE_URL when
  // it's set; otherwise DATABASE_URL (a local database is both).
  datasource: {
    url: process.env['DIRECT_DATABASE_URL'] || process.env['DATABASE_URL'],
  },
});
