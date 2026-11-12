// Website embeds: an organisation's tables, fixtures, results and live scores on its own website,
// in an iframe. Off until Ovalcast staff approve them for that organisation; then they show only on
// the websites the organisation lists (the website sends them as frame-ancestors).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EmbedAccess, EmbedSettings, User } from '@/api/types';
import type * as P from '~/generated/prisma/client';
import { json, prisma, toJson } from '~/db/client';
import { requireStaff, requireUser } from '~/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '~/lib/errors';
import { isLeagueAdmin, notify } from '~/lib/repo';
import { logStaff } from '~/lib/staffLog';

const MAX_DOMAINS = 10;

export const embedSettingsOf = (o: P.Organisation): EmbedSettings => ({
  orgId: o.id,
  status: o.embedsApprovedAt ? 'approved' : o.embedsRequestedAt ? 'requested' : 'off',
  requestedAt: o.embedsRequestedAt?.toISOString(),
  approvedAt: o.embedsApprovedAt?.toISOString(),
  domains: json<string[]>(o.embedDomains) ?? [],
});

/**
 * A website address as typed or pasted (https://www.ccclagos.com/fixtures) to the host part a
 * browser checks (www.ccclagos.com). *.ccclagos.com covers every subdomain. A port is kept.
 */
export function cleanDomain(raw: string): string | undefined {
  let v = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '');
  if (!v) return undefined;
  v = v.replace(/\.$/, '');
  const ok = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d{2,5})?$/.test(v) || /^localhost(:\d{2,5})?$/.test(v);
  return ok ? v : undefined;
}

async function org(id: string) {
  const o = await prisma.organisation.findUnique({ where: { id } });
  if (!o) throw notFound('Organisation');
  return o;
}

const adminOrStaff = (user: User, orgId: string) => {
  if (!isLeagueAdmin(user, orgId) && !user.staff) throw forbidden('Only this organisation’s admins can see this');
};

export async function embedRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/organisations/:id/embeds', async (req) => {
    const user = requireUser(req);
    adminOrStaff(user, req.params.id);
    return embedSettingsOf(await org(req.params.id));
  });

  // An organisation asks Ovalcast to switch embeds on. Staff hear about it.
  app.post<{ Params: { id: string } }>('/organisations/:id/embeds/request', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only this organisation’s admins can ask');
    const o = await org(req.params.id);
    if (o.embedsApprovedAt || o.embedsRequestedAt) return embedSettingsOf(o);
    const saved = await prisma.organisation.update({ where: { id: o.id }, data: { embedsRequestedAt: new Date() } });
    const staff = await prisma.user.findMany({ where: { staff: true }, select: { id: true } });
    await notify(staff.map((s) => s.id), { kind: 'community', title: `${o.name} asked for website embeds`, body: `${user.name} would like their tables and fixtures on their own website. Approve it in the backoffice.` });
    return embedSettingsOf(saved);
  });

  // The websites the embeds may appear on. Only once approved.
  app.put<{ Params: { id: string } }>('/organisations/:id/embeds', async (req) => {
    const user = requireUser(req);
    if (!isLeagueAdmin(user, req.params.id)) throw forbidden('Only this organisation’s admins can change this');
    const { domains } = z.object({ domains: z.array(z.string()).max(MAX_DOMAINS, `Up to ${MAX_DOMAINS} websites`) }).parse(req.body);
    const o = await org(req.params.id);
    if (!o.embedsApprovedAt) throw conflict('Website embeds aren’t switched on for this organisation yet');
    const cleaned = domains.map((d) => [d, cleanDomain(d)] as const);
    const bad = cleaned.filter(([, c]) => !c).map(([d]) => d);
    if (bad.length) throw badRequest(`Not a website address: ${bad.join(', ')}. Use the form ccclagos.com or www.ccclagos.com.`);
    const saved = await prisma.organisation.update({ where: { id: o.id }, data: { embedDomains: toJson([...new Set(cleaned.map(([, c]) => c!))]) } });
    return embedSettingsOf(saved);
  });

  // For the website's server, before it shows an embed: may it, and on which websites. Public.
  app.get('/embeds/access', async (req): Promise<EmbedAccess> => {
    const q = z.object({ orgId: z.string().optional(), competitionId: z.string().optional() }).parse(req.query);
    const orgId = q.orgId ?? (q.competitionId ? (await prisma.competition.findUnique({ where: { id: q.competitionId }, select: { orgId: true } }))?.orgId : undefined);
    if (!orgId) throw notFound('Organisation');
    const o = await org(orgId);
    return { orgId: o.id, orgName: o.name, approved: !!o.embedsApprovedAt, domains: o.embedsApprovedAt ? (json<string[]>(o.embedDomains) ?? []) : [] };
  });

  // Ovalcast staff switch embeds on or off.
  app.put<{ Params: { id: string } }>('/staff/organisations/:id/embeds', async (req) => {
    const staff = requireStaff(req);
    const { approved } = z.object({ approved: z.boolean() }).parse(req.body);
    const o = await org(req.params.id);
    const saved = await prisma.organisation.update({ where: { id: o.id }, data: approved ? { embedsApprovedAt: o.embedsApprovedAt ?? new Date(), embedsApprovedBy: o.embedsApprovedBy ?? staff.name } : { embedsApprovedAt: null, embedsApprovedBy: null } });
    await logStaff(staff, approved ? 'approveEmbeds' : 'revokeEmbeds', 'organisation', o.id);
    const admins = await prisma.membership.findMany({ where: { orgId: o.id, role: { in: ['leagueAdmin', 'owner'] } }, select: { userId: true } });
    await notify(
      admins.map((a) => a.userId),
      approved
        ? { kind: 'community', title: 'Website embeds are on', body: `Put ${o.name}’s tables, fixtures, results and live scores on your own website.`, link: { pathname: '/organisation/[id]', params: { id: o.id } } }
        : { kind: 'community', title: 'Website embeds are off', body: `${o.name}’s embeds no longer show on other websites. Contact Ovalcast to ask why.` },
    );
    return embedSettingsOf(saved);
  });
}
