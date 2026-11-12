// Issues a partner API key to an Organisation-plan customer, after the scope,
// price and terms (no betting use) are agreed. There is no self-serve key.
//
//   npm run api:issue -- --org org_ccc --name "CCC Lagos website"          (sandbox key)
//   npm run api:issue -- --org org_ccc --name "CCC Lagos website" --live   (once the integration is checked)
//
// The key is printed once; only its hash is stored.

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { prisma } from '~/db/client';
import { newId } from '~/lib/ids';
import { newApiKey } from '~/routes/partner';

const { values } = parseArgs({ options: { org: { type: 'string' }, name: { type: 'string' }, live: { type: 'boolean', default: false } } });
if (!values.org || !values.name) {
  console.error('Usage: npm run api:issue -- --org <organisation id> --name "<what it is for>" [--live]');
  process.exit(1);
}
const org = await prisma.organisation.findUnique({ where: { id: values.org } });
if (!org) throw new Error(`No organisation ${values.org}`);
if (org.plan !== 'organisation') throw new Error(`${org.name} is not on the Organisation plan; the API is part of it.`);
const { key, hash, prefix } = newApiKey(!values.live);
await prisma.apiClient.create({ data: { id: newId('api'), orgId: org.id, name: values.name, keyHash: hash, keyPrefix: prefix, sandbox: !values.live } });
console.log(`${values.live ? 'Live' : 'Sandbox'} key for ${org.name}, ${values.name}:\n\n  ${key}\n\nIt is shown only now. Send it to the organisation by a secure channel.`);
await prisma.$disconnect();
