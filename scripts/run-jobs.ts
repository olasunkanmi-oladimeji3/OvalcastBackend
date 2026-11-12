// Runs the scheduled jobs once: npm run jobs
import 'dotenv/config';
import { prisma } from '~/db/client';
import { runJobs } from '~/services/jobs';

console.log(await runJobs());
await prisma.$disconnect();
