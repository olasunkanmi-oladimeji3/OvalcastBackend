# OvalcastBackend

The Ovalcast API: Fastify 5, Prisma 7 and Postgres. It serves the Ovalcast app, website and partner API.

`shared/` holds the scoring engine and the API types that the app and website use too. Change them in the Ovalcast monorepo, then refresh this repository with `scripts/export-backend.sh` from there.

## Run it

```sh
cp .env.example .env              # then set DATABASE_URL to a local Postgres
npm ci && npx prisma generate
npm run db:deploy                 # the tables
npm run db:seed                   # demo data (local databases only)
npm run dev                       # http://localhost:4000
```

## Deploy

- **Render:** `render.yaml` sets up the API. Every secret is entered in Render's dashboard.
- **Supabase:** use the transaction pooler for `DATABASE_URL`, the session pooler for `DIRECT_DATABASE_URL`, and Supabase's SSL certificate for `DATABASE_CA_CERT`.
- **Check the database:** `npm run db:check`.
- **Migrations:** `npm run db:deploy`. Never run `db:seed` against staging or production.
