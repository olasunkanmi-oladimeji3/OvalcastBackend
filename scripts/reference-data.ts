// Reference data every Ovalcast server needs, demo or live: the regions (a country and its cities)
// that officials, top players, "Looking for" posts and profiles are grouped by.
//
// Safe on production: it only adds missing regions and refreshes their names, cities and map
// positions. It never deletes anything and never touches accounts, clubs, leagues or matches. It
// runs on every deploy (after the migrations), so a new region added to the list goes live then.
//
//   npm run db:reference
import { REGIONS } from '@/api/mock/seed';
import { prisma } from '../src/db/client';

async function main() {
  let added = 0;
  for (const r of REGIONS) {
    const data = { name: r.name, country: r.country, lat: r.lat, lon: r.lon, cities: r.cities };
    const before = await prisma.region.findUnique({ where: { id: r.id }, select: { id: true } });
    await prisma.region.upsert({ where: { id: r.id }, create: { id: r.id, ...data }, update: data });
    if (!before) added += 1;
  }
  console.log(`Regions: ${REGIONS.length} in the list, ${added} added.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
