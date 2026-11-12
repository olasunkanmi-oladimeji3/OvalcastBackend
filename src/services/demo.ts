// Development only: keeps demo matches that are live, and scored by someone
// other than the developer, moving one ball at a time, so live screens move.

import type { FastifyBaseLogger } from 'fastify';
import { mulberry32, nextBall } from '@/api/mock/simulate';
import { prisma } from '~/db/client';
import { toMatch } from '~/lib/repo';
import { recordBall } from '~/routes/matches';
import { ballEventsFor, setupFor } from './matches';

const DEMO_SCORERS = ['user_ngozi'];
const rng = mulberry32(Date.now() % 100000);

export function startDemoSimulator(log: FastifyBaseLogger, everyMs = 9000) {
  log.info('Demo simulator on: live demo matches move every %d s', everyMs / 1000);
  setInterval(async () => {
    try {
      const live = (await prisma.match.findMany({ where: { status: { in: ['live', 'inningsBreak'] }, scorerUserId: { in: DEMO_SCORERS } } })).map(toMatch);
      for (const m of live) {
        const ball = nextBall(await setupFor(m), await ballEventsFor(m.id), rng, m.id, new Date());
        if (!ball) continue;
        const { id: _i, matchId: _m, createdAt: _c, createdBy: _b, ...input } = ball;
        await recordBall(m, input, m.officials.scorerUserId!);
      }
    } catch (e) {
      log.error(e, 'demo simulator');
    }
  }, everyMs);
}

