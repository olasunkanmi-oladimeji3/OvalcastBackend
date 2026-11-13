// Inviting players to a club, one at a time or from a spreadsheet. Two ways to reach someone:
// WhatsApp (the club admin's phone opens WhatsApp with the message, since WhatsApp can't be sent to
// automatically without a paid business account) or email (sent by the server). An email invitation
// can only be accepted by an account with that email address; a WhatsApp link by whoever opens it.
import { readSheet } from 'read-excel-file/node';
import { normaliseIdentifier } from '@/engine';
import { prisma } from '~/db/client';
import { badRequest } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { messenger } from '~/lib/messaging';
import { notify } from '~/lib/repo';

export type InviteChannel = 'whatsapp' | 'email';
export interface InviteInput { name: string; channel: InviteChannel; contact: string; dateOfBirth?: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** The link the invited person opens: the website's join page (the app opens the same link). */
export const inviteLink = (id: string) => `${(process.env.WEB_URL ?? 'http://localhost:3100').replace(/\/$/, '')}/join/${id}`;

/** The message the club sends, by WhatsApp or as the email's text. */
export const inviteMessage = (name: string, club: string, id: string) =>
  `Hello ${name.split(/\s+/)[0]}, ${club} has invited you to join the club on Ovalcast. Open this link to accept (you can create your account from it if you don't have one): ${inviteLink(id)}`;

/** A cleaned-up contact, or the reason it isn't usable. */
export function checkContact(channel: InviteChannel, contact: string, country?: string): { ok: true; contact: string } | { ok: false; reason: string } {
  const raw = contact.trim();
  if (channel === 'email') return EMAIL.test(raw) ? { ok: true, contact: raw.toLowerCase() } : { ok: false, reason: 'Not an email address' };
  const phone = normaliseIdentifier(raw, country);
  return /^\+\d{8,15}$/.test(phone) ? { ok: true, contact: phone } : { ok: false, reason: 'Not a WhatsApp number (include the country code, e.g. +234…)' };
}

/** An invitation as the club sees it, with its link. */
export const toInvite = (i: { id: string; teamId: string; name: string; channel: string; contact: string; status: string; createdAt: Date; dateOfBirth?: Date | null }) => ({
  id: i.id, teamId: i.teamId, name: i.name, channel: i.channel as InviteChannel, contact: i.contact, status: i.status as 'pending' | 'joined' | 'cancelled', createdAt: i.createdAt.toISOString(), dateOfBirth: i.dateOfBirth ? i.dateOfBirth.toISOString().slice(0, 10) : undefined, link: inviteLink(i.id),
});

/** Shows t***@example.com or +234 *** *** 0199: enough for the invited person to recognise it. */
export const maskContact = (c: string) => (c.includes('@') ? c.replace(/^(.)[^@]*@/, '$1***@') : c.replace(/^(\+\d{1,3})\d*(\d{4})$/, '$1 *** *** $2'));

/** Creates an invitation, emails it when it's by email, and tells an existing account in the app too. */
export async function createInvite(teamId: string, input: InviteInput, inviterCountry?: string) {
  const name = input.name.trim();
  if (!name) throw badRequest('Give the player’s name');
  const contact = checkContact(input.channel, input.contact, inviterCountry);
  if (!contact.ok) throw badRequest(contact.reason);
  const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { name: true } });
  const inv = await prisma.playerInvite.create({ data: { id: newId('pinv'), teamId, name, channel: input.channel, contact: contact.contact, status: 'pending', dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null } });
  if (input.channel === 'email') {
    await messenger.sendEmail(contact.contact, `${team.name} invited you to join on Ovalcast`, `${inviteMessage(name, team.name, inv.id)}\n\nIf you weren't expecting this, you can ignore this email.`).catch((e) => console.error('[invites] email not sent', e));
  }
  // Someone already on Ovalcast with that email or number sees it in the app as well.
  const existing = await prisma.user.findFirst({ where: input.channel === 'email' ? { email: contact.contact } : { phone: contact.contact }, select: { id: true } });
  if (existing) await notify([existing.id], { kind: 'invite', title: `${team.name} invited you to join`, body: 'Open it to accept or decline.', link: { pathname: '/join/[id]', params: { id: inv.id } } });
  return toInvite(inv);
}

export interface RosterRow { row: number; name: string; contact: string; channel?: InviteChannel; dateOfBirth?: string; problem?: string }

const header = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const cell = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());

/** Splits CSV text into rows, with quoted fields ("Okafor, Chidi") handled. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * Reads a roster from a .csv or .xlsx file: a header row, then one player per row. Columns are found
 * by name (Name, WhatsApp or Phone, Email, Date of birth), in any order. Each row says what's wrong
 * with it, if anything; nothing is created here.
 */
export async function readRoster(data: Buffer, filename: string, country?: string, already: { names: string[]; contacts: string[] } = { names: [], contacts: [] }): Promise<RosterRow[]> {
  const isXlsx = /\.xlsx$/i.test(filename) || data.subarray(0, 2).toString() === 'PK';
  let rows: unknown[][];
  try {
    rows = isXlsx ? ((await readSheet(data)) as unknown[][]) : csvRows(data.toString('utf8').replace(/^﻿/, ''));
  } catch {
    throw badRequest('That file couldn’t be read. Use the template, saved as .csv or .xlsx');
  }
  if (rows.length < 2) throw badRequest('The file has no players in it: put a header row, then one player per row');
  if (rows.length > 301) throw badRequest('Up to 300 players at a time');
  const heads = rows[0].map(header);
  const col = (...names: string[]) => heads.findIndex((h) => names.includes(h));
  const nameCol = col('name', 'fullname', 'playername');
  const phoneCol = col('whatsapp', 'whatsappnumber', 'phone', 'phonenumber', 'mobile');
  const emailCol = col('email', 'emailaddress');
  const dobCol = col('dateofbirth', 'dob', 'birthday', 'born');
  if (nameCol < 0 || (phoneCol < 0 && emailCol < 0)) throw badRequest('The header row needs a Name column and a WhatsApp or Email column. Download the template to see how');
  const seen = new Set<string>();
  const knownNames = new Set(already.names.map((n) => n.toLowerCase()));
  const knownContacts = new Set(already.contacts);
  return rows.slice(1).map((r, i) => {
    const name = cell(r[nameCol]);
    const email = emailCol >= 0 ? cell(r[emailCol]) : '';
    const phone = phoneCol >= 0 ? cell(r[phoneCol]) : '';
    const channel: InviteChannel | undefined = email ? 'email' : phone ? 'whatsapp' : undefined;
    const dobRaw = dobCol >= 0 ? cell(r[dobCol]) : '';
    const dob = /^\d{4}-\d{2}-\d{2}$/.test(dobRaw) ? dobRaw : /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.test(dobRaw) ? dobRaw.replace(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/, (_, d, m, y) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`) : undefined;
    const out: RosterRow = { row: i + 2, name, contact: email || phone, channel, dateOfBirth: dob };
    if (!name) return { ...out, problem: 'No name' };
    if (!channel) return { ...out, problem: 'No WhatsApp number or email' };
    const c = checkContact(channel, out.contact, country);
    if (!c.ok) return { ...out, problem: c.reason };
    out.contact = c.contact;
    if (dobRaw && !dob) return { ...out, problem: 'Date of birth not understood (use YYYY-MM-DD or DD/MM/YYYY)' };
    if (seen.has(c.contact)) return { ...out, problem: 'Same contact as an earlier row' };
    seen.add(c.contact);
    if (knownContacts.has(c.contact)) return { ...out, problem: 'Already invited' };
    if (knownNames.has(name.toLowerCase())) return { ...out, problem: 'Already in the squad' };
    return out;
  });
}
