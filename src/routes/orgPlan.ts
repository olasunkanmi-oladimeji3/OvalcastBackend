// The Organisation plan, bought by an organisation's admins: ₦25,000 a month in Nigeria, $25 a month
// elsewhere, or a year at 15% off. It switches on unlimited leagues, online entry fees, branding,
// website embeds and the partner API. Renewals aren't charged automatically: admins are reminded
// five days before, and the plan goes back to Free three days after an unpaid renewal (unless
// Ovalcast put the organisation on it by contract). With the plan, admins create their own API keys.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiClientSummary, OrganisationPlanStatus } from '@/api/types';
import { organisationPrice } from '@/engine';
import { json, prisma } from '~/db/client';
import { requireUser } from '~/lib/auth';
import { conflict, forbidden, notFound } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { isLeagueAdmin } from '~/lib/repo';
import { startCheckout } from '~/services/billing';
import { newApiKey } from './partner';

const METHOD = z.enum(['card', 'bankTransfer', 'ussd', 'mobileMoney']);

async function statusOf(orgId: string): Promise<OrganisationPlanStatus> {
  const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { plan: true, planContract: true, country: true } });
  if (!org) throw notFound('Organisation');
  const sub = await prisma.subscription.findFirst({ where: { orgId, status: { not: 'cancelled' } }, orderBy: { renewsAt: 'desc' } });
  return {
    plan: org.plan === 'organisation' ? 'organisation' : 'free',
    contract: org.planContract,
    price: organisationPrice(org.country),
    ...(sub ? { subscription: { interval: sub.interval as 'monthly' | 'yearly', status: sub.status as 'active' | 'pastDue', renewsAt: sub.renewsAt.toISOString(), cancelAtPeriodEnd: sub.cancelAtPeriodEnd, amount: sub.amount, currency: sub.currency } } : {}),
  };
}

export async function orgPlanRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/organisations/:id/plan', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can see its plan');
    return statusOf(req.params.id);
  });

  // Subscribe or renew: monthly or yearly, paid on Flutterwave.
  app.post<{ Params: { id: string } }>('/organisations/:id/plan', async (req) => {
    const user = requireUser(req);
    const b = z.object({ interval: z.enum(['monthly', 'yearly']), method: METHOD }).parse(req.body);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can subscribe');
    const st = await statusOf(req.params.id);
    if (st.contract) throw conflict('Your organisation is on the Organisation plan by agreement with Ovalcast. Nothing to pay here');
    const org = await prisma.organisation.findUniqueOrThrow({ where: { id: req.params.id }, select: { name: true } });
    const amount = b.interval === 'monthly' ? st.price.monthly : st.price.yearly;
    return startCheckout({ kind: 'organisation', user, refId: req.params.id, amount, currency: st.price.currency, method: b.method, title: `Ovalcast Organisation plan for ${org.name}, ${b.interval}`, meta: { interval: b.interval } });
  });

  // Stop renewing: the plan stays on to the end of the period already paid.
  app.delete<{ Params: { id: string } }>('/organisations/:id/plan', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can cancel');
    const sub = await prisma.subscription.findFirst({ where: { orgId: req.params.id, status: { not: 'cancelled' } } });
    if (!sub) throw notFound('Subscription');
    await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    return statusOf(req.params.id);
  });

  // With the plan, admins create their own API keys. The key is shown once; only a hash is kept.
  app.post<{ Params: { id: string } }>('/organisations/:id/api-clients', async (req) => {
    const user = requireUser(req);
    const { name } = z.object({ name: z.string().trim().min(2, 'Name the key, for example “Club website”').max(60) }).parse(req.body);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only the organisation’s admins can create API keys');
    const org = await prisma.organisation.findUnique({ where: { id: req.params.id }, select: { plan: true } });
    if (org?.plan !== 'organisation') throw conflict('API keys come with the Organisation plan. Subscribe first');
    const active = await prisma.apiClient.count({ where: { orgId: req.params.id, revokedAt: null } });
    if (active >= 5) throw conflict('You have 5 keys already. Revoke one you no longer use first');
    const { key, hash, prefix } = newApiKey(false);
    const c = await prisma.apiClient.create({ data: { id: newId('api'), orgId: req.params.id, name, keyHash: hash, keyPrefix: prefix, sandbox: false }, include: { webhooks: true } });
    const client: ApiClientSummary = { id: c.id, name: c.name, keyPrefix: c.keyPrefix, sandbox: false, createdAt: c.createdAt.toISOString(), requestsThisMonth: 0, webhooks: c.webhooks.map((w) => ({ id: w.id, url: w.url, events: json<string[]>(w.events), active: w.active })) };
    return { client, key };
  });
}
