// Partner webhooks: events for an organisation's matches go to every endpoint
// its API clients registered, signed and retried with backoff.
//
//   x-ovalcast-event: match.completed
//   x-ovalcast-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the endpoint secret>

import { createHmac } from 'node:crypto';
import { json, prisma, toJson } from '~/db/client';
import { withLock } from '~/lib/lock';
import { safePost } from '~/lib/safeFetch';
import { newId } from '~/lib/ids';

export const PARTNER_EVENTS = ['match.started', 'wicket', 'milestone', 'innings.ended', 'match.completed', 'stream.live', 'clip.ready'] as const;
export type PartnerEvent = (typeof PARTNER_EVENTS)[number];

const MAX_ATTEMPTS = 8;

/** Queues an event for the organisation that owns the match. Friendlies have no organisation and send nothing. */
export async function emitPartnerEvent(event: PartnerEvent, matchId: string, data: Record<string, unknown>) {
  const m = await prisma.match.findUnique({ where: { id: matchId }, select: { competition: { select: { orgId: true } } } });
  const orgId = m?.competition?.orgId;
  if (!orgId) return;
  const hooks = await prisma.partnerWebhook.findMany({ where: { active: true, client: { orgId, revokedAt: null } } });
  const due = hooks.filter((h) => json<string[]>(h.events).includes(event));
  if (!due.length) return;
  const payload = { id: newId('evt'), type: event, createdAt: new Date().toISOString(), data: { matchId, ...data } };
  await prisma.webhookDelivery.createMany({ data: due.map((h) => ({ id: newId('dlv'), webhookId: h.id, event, payload: toJson(payload), status: 'pending' })) });
}

export function signature(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Sends due deliveries. Backoff doubles from one minute; after 8 tries a delivery is marked failed. */
/** One machine at a time, so a partner never gets the same webhook twice. */
export async function deliverWebhooks(now = new Date()) {
  return withLock('ovalcast:webhooks', () => deliverDue(now), 5 * 60_000);
}

async function deliverDue(now: Date) {
  const due = await prisma.webhookDelivery.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now } }, include: { webhook: true }, take: 50, orderBy: { nextAttemptAt: 'asc' } });
  for (const d of due) {
    const body = JSON.stringify(d.payload);
    // To the partner's address, which is theirs to choose: never to anything internal (lib/safeFetch).
    const sent = await safePost(d.webhook.url, body, { 'Content-Type': 'application/json', 'x-ovalcast-event': d.event, 'x-ovalcast-signature': signature(d.webhook.secret, body) });
    const error = sent.ok ? undefined : sent.error;
    const attempts = d.attempts + 1;
    await prisma.webhookDelivery.update({
      where: { id: d.id },
      data: error
        ? { attempts, lastError: error.slice(0, 300), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', nextAttemptAt: new Date(now.getTime() + 60_000 * 2 ** (attempts - 1)) }
        : { attempts, status: 'delivered', deliveredAt: new Date(), lastError: null },
    });
  }
  return due.length;
}

export function startWebhookWorker(everyMs = 10_000) {
  const t = setInterval(() => void deliverWebhooks().catch(() => undefined), everyMs);
  t.unref();
  return () => clearInterval(t);
}
