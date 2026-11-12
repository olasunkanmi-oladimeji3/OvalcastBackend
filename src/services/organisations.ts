// Starting an organisation: from "Start an organisation", or from signing up as one. The person
// becomes its owner and a league admin.

import { z } from 'zod';
import { currencyForCountry } from '@/engine';
import { prisma, toJson } from '~/db/client';
import { conflict } from '~/lib/errors';
import { newId } from '~/lib/ids';

export const ORG_KINDS = ['league', 'association', 'festival', 'school', 'academy', 'corporate'] as const;

export const newOrganisationSchema = z.object({
  name: z.string().trim().min(3, 'Give the organisation its full name').max(80),
  shortName: z.string().trim().max(8).default(''),
  kind: z.enum(ORG_KINDS),
  city: z.string().trim().min(1, 'Add the organisation’s city'),
  country: z.string().trim().min(2, 'Pick the country').max(60),
  about: z.string().trim().max(400).default(''),
});
export type NewOrganisation = z.infer<typeof newOrganisationSchema>;

const TAKEN = 'An organisation with that name is already on Ovalcast. Ask its owner to add you as an admin.';

/** Throws 409 when an organisation already has this name (names are unique, ignoring case). */
export async function checkOrganisationName(name: string) {
  if (await prisma.organisation.findFirst({ where: { name: { equals: name.trim(), mode: 'insensitive' } }, select: { id: true } })) throw conflict(TAKEN);
}

/** Creates the organisation, in its country's currency, with this person as owner and league admin. */
export async function createOrganisation(user: { id: string; name: string }, b: NewOrganisation) {
  await checkOrganisationName(b.name);
  const base = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  const id = (await prisma.organisation.findUnique({ where: { id: `org_${base}` } })) ? `org_${base}_${newId('x').slice(-4)}` : `org_${base}`;
  const shortName = b.shortName || b.name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 6);
  return prisma.$transaction(async (tx) => {
    const o = await tx.organisation.create({ data: { id, name: b.name, shortName, kind: b.kind, city: b.city, country: b.country, currency: currencyForCountry(b.country), about: b.about, founded: new Date().getFullYear(), executives: toJson([{ name: user.name, title: 'Founder' }]), plan: 'free' } });
    await tx.membership.createMany({ data: [{ id: newId('mem'), userId: user.id, orgId: o.id, role: 'owner' }, { id: newId('mem'), userId: user.id, orgId: o.id, role: 'leagueAdmin' }] });
    // An organisation they signed up for and couldn't have (its name was taken): this replaces it.
    const row = await tx.user.findUnique({ where: { id: user.id }, select: { settings: true } });
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    if (settings.pendingOrganisation) {
      const { pendingOrganisation: _done, ...rest } = settings;
      await tx.user.update({ where: { id: user.id }, data: { settings: toJson(rest) } });
    }
    return o;
  });
}
