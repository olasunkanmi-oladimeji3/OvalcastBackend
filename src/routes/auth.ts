// Accounts: sign up, sign in with email or phone, one-time codes, password
// reset, sessions, and adding a second email or phone.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { countryOfPhone } from '@/engine';
import type { AuthSession, CodeSent, SignInResult } from '@/api/types';
import { json, prisma, toJson } from '~/db/client';
import { checkOrganisationName, createOrganisation, ORG_KINDS } from '~/services/organisations';
import { requireUser } from '~/lib/auth';
import { hashPassword, newToken, sha256, sixDigitCode, verifyPassword } from '~/lib/crypto';
import { ApiError, badRequest, conflict } from '~/lib/errors';
import { newId } from '~/lib/ids';
import { messenger } from '~/lib/messaging';
import { loadUser, notify } from '~/lib/repo';

const CODE_TTL_MS = 10 * 60_000;
const RESEND_MS = 30_000;
const MAX_ATTEMPTS = 5;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const returnCodes = process.env.DEV_RETURN_CODES === 'true' && process.env.NODE_ENV !== 'production';

const phoneRe = /^\+\d{10,15}$/;
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const normalise = (id: string) => (id.includes('@') ? id.trim().toLowerCase() : id.replace(/\s/g, ''));

/**
 * A date of birth as YYYY-MM-DD: a real date, in the past, for someone aged 5 to 100. Kept private;
 * it decides age rules (under-18s, a league's QYP age limit).
 */
const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Add your date of birth')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return false;
    const age = (Date.now() - d.getTime()) / (365.25 * 86_400_000);
    return age >= 5 && age <= 100;
  }, 'Check your date of birth');

/** No text messages: codes go by email. A phone number is a contact (WhatsApp), not verified. */
const PHONE_CODES = 'Codes go by email only. Sign in with your email, or add an email to your account in Settings to reset your password.';
const mask = (id: string) => (id.includes('@') ? `${id[0]}***@${id.split('@')[1]}` : `${id.slice(0, 4)} *** *** ${id.slice(-4)}`);

const findByIdentifier = (identifier: string) => prisma.user.findUnique({ where: identifier.includes('@') ? { email: identifier } : { phone: identifier } });

async function startSession(userId: string): Promise<AuthSession> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { suspendedAt: true } });
  if (u?.suspendedAt) throw new ApiError(403, 'This account is suspended. Contact Ovalcast support to ask about it.');
  const token = newToken();
  const days = Number(process.env.SESSION_DAYS ?? 60);
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt: new Date(Date.now() + days * 86_400_000) } });
  return { token, user: (await loadUser(userId))! };
}

/**
 * Sends a code. `reuseRecent`: a code sent moments ago (within the resend wait) still stands, so
 * the reply points to it instead of refusing; signing in straight after signing up uses this.
 */
async function sendCode(identifier: string, purpose: 'verify' | 'reset', userId?: string, opts: { reuseRecent?: boolean } = {}): Promise<CodeSent> {
  const key = { identifier_purpose: { identifier, purpose } };
  const prev = await prisma.verificationCode.findUnique({ where: key });
  if (prev) {
    const wait = Math.ceil((prev.sentAt.getTime() + RESEND_MS - Date.now()) / 1000);
    if (wait > 0 && opts.reuseRecent && prev.expiresAt.getTime() > Date.now()) {
      return { channel: identifier.includes('@') ? 'email' : 'phone', destination: mask(identifier), expiresInSeconds: Math.ceil((prev.expiresAt.getTime() - Date.now()) / 1000), resendInSeconds: wait };
    }
    if (wait > 0) throw new ApiError(429, `Wait ${wait} seconds before asking for another code`);
  }
  const code = sixDigitCode();
  const now = new Date();
  const row = { codeHash: sha256(`${identifier}:${code}`), attempts: 0, sentAt: now, expiresAt: new Date(now.getTime() + CODE_TTL_MS), userId: userId ?? null };
  await prisma.verificationCode.upsert({ where: key, create: { identifier, purpose, ...row }, update: row });
  try {
    await messenger.sendCode(identifier, code, purpose);
  } catch (e) {
    // Not sent: forget it, so they can ask again straight away instead of waiting out the resend timer.
    await prisma.verificationCode.delete({ where: key }).catch(() => {});
    console.error(e);
    throw new ApiError(502, identifier.includes('@') ? 'We couldn’t send the email just now. Try again in a minute.' : 'We couldn’t send the text just now. Check the number, or try again in a minute.');
  }
  return { channel: identifier.includes('@') ? 'email' : 'phone', destination: mask(identifier), expiresInSeconds: CODE_TTL_MS / 1000, resendInSeconds: RESEND_MS / 1000, devCode: returnCodes ? code : undefined };
}

async function checkCode(identifier: string, code: string, purpose: 'verify' | 'reset') {
  const key = { identifier_purpose: { identifier, purpose } };
  const c = await prisma.verificationCode.findUnique({ where: key });
  if (!c || c.expiresAt.getTime() < Date.now()) throw new ApiError(410, 'That code has expired. Ask for a new one.');
  if (c.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'Too many tries. Ask for a new code.');
  if (c.codeHash !== sha256(`${identifier}:${code.trim()}`)) {
    await prisma.verificationCode.update({ where: key, data: { attempts: { increment: 1 } } });
    throw new ApiError(400, `That code is not right. ${MAX_ATTEMPTS - c.attempts - 1} tries left.`);
  }
  await prisma.verificationCode.delete({ where: key });
  return c;
}

// Phone-only accounts get SMS alerts by default, since they may not keep data on.
const defaultSettings = (hasPhone: boolean, _hasEmail: boolean, accountType: 'player' | 'organisation', pendingOrganisation?: { name: string; kind: string; city: string; country: string }) => ({
  dataSaver: false,
  // No text messages: alerts go by push and, where there's a number, WhatsApp.
  alerts: { push: true, sms: false, whatsapp: hasPhone },
  alertTopics: { myMatches: true, myClubs: true, wickets: false, results: true, leagueAdmin: true },
  accountType,
  // A player is taken through setting up their cricket career once they've verified. Someone
  // signing up for an organisation goes to it instead, and can set up their own career later.
  careerSetupDone: accountType !== 'player',
  // Created once the code is verified, so an unverified account can't take an organisation's name.
  ...(pendingOrganisation ? { pendingOrganisation } : {}),
});

/**
 * Someone who signed up for an organisation: create it now they've verified, with them as owner.
 * If the name was taken in the meantime, it stays pending and the app asks for another name.
 */
async function createPendingOrganisation(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, settings: true } });
  const settings = json<Record<string, unknown>>(u.settings);
  const pending = settings.pendingOrganisation as { name: string; kind: (typeof ORG_KINDS)[number]; city: string; country: string } | undefined;
  if (!pending) return;
  try {
    await createOrganisation({ id: userId, name: u.name }, { ...pending, shortName: '', about: '' });
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return;
    throw e;
  }
  const { pendingOrganisation: _done, ...rest } = settings;
  await prisma.user.update({ where: { id: userId }, data: { settings: toJson(rest) } });
}

/**
 * The account's date of birth onto the person's player records that have none (their own profile and
 * any they've claimed), marking under-18s, so age rules have it.
 */
export async function copyBirthDateToPlayers(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, playerId: true } });
  if (!u?.dateOfBirth) return;
  const ids = [...(u.playerId ? [u.playerId] : []), ...(await prisma.player.findMany({ where: { claimedByUserId: userId }, select: { id: true } })).map((p) => p.id)];
  const minor = (Date.now() - u.dateOfBirth.getTime()) / (365.25 * 86_400_000) < 18;
  await prisma.player.updateMany({ where: { id: { in: ids }, dateOfBirth: null }, data: { dateOfBirth: u.dateOfBirth, ...(minor ? { minor: true } : {}) } });
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/sign-up', async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1, 'Add your name'), email: z.string().optional(), phone: z.string().optional(), password: z.string().min(8, 'Use a password of at least 8 characters'), city: z.string().optional(), country: z.string().trim().max(60).optional(),
        dateOfBirth,
        // Player: anyone who plays, officiates, coaches, runs a club or follows. Organisation: a body that runs competitions.
        accountType: z.enum(['player', 'organisation']).default('player'),
        organisation: z.object({ name: z.string().trim().min(3, 'Give the organisation its full name').max(80), kind: z.enum(ORG_KINDS), city: z.string().trim().min(1, 'Add the organisation’s city') }).optional(),
      })
      .parse(req.body);
    if (body.accountType === 'organisation' && !body.organisation) throw badRequest('Add the organisation’s name, type and city');
    const email = body.email ? normalise(body.email) : undefined;
    const phone = body.phone ? normalise(body.phone) : undefined;
    if (email && !isEmail(email)) throw badRequest('Enter an email like name@example.com');
    if (phone && !phoneRe.test(phone)) throw badRequest('Enter the phone number with its + country code');
    const identifier = email ?? phone;
    if (!identifier) throw badRequest('Add an email or a phone number');
    if (await findByIdentifier(identifier)) throw conflict('There is already an account with that email or phone. Sign in instead.');
    // Say now if the organisation's name is taken, rather than after the code.
    if (body.accountType === 'organisation') await checkOrganisationName(body.organisation!.name);
    const id = newId('user');
    const country = body.country || (phone ? countryOfPhone(phone)?.name : undefined) || null;
    const pending = body.accountType === 'organisation' ? { ...body.organisation!, country: country ?? 'Another country' } : undefined;
    await prisma.user.create({ data: { id, name: body.name, email: email ?? null, phone: phone ?? null, passwordHash: await hashPassword(body.password), city: body.city?.trim() || null, country, dateOfBirth: new Date(body.dateOfBirth), settings: toJson(defaultSettings(!!phone, !!email, body.accountType, pending)) } });
    await notify(id, body.accountType === 'organisation'
      ? { kind: 'community', title: `Welcome to Ovalcast, ${body.name.split(' ')[0]}`, body: `Once you've verified, ${body.organisation!.name} is ready: create its first competition and invite clubs.` }
      : { kind: 'community', title: `Welcome to Ovalcast, ${body.name.split(' ')[0]}`, body: 'Create your club, join a league, or find a game near you on the Looking for board.', link: { pathname: '/community' } });
    // A phone number can't be verified without text messages: the account starts straight away.
    // An email is verified with a code, as before.
    if (!email) {
      await createPendingOrganisation(id);
      return { identifier, session: await startSession(id) };
    }
    return { identifier, code: await sendCode(identifier, 'verify') };
  });

  app.post('/auth/sign-in', async (req): Promise<SignInResult> => {
    const body = z.object({ identifier: z.string().min(3), password: z.string().min(1) }).parse(req.body);
    const identifier = normalise(body.identifier);
    const u = await findByIdentifier(identifier);
    if (u?.lockedUntil && u.lockedUntil.getTime() > Date.now()) throw new ApiError(429, 'Too many wrong passwords. Try again in 15 minutes, or reset your password.');
    if (!u || !(await verifyPassword(u.passwordHash, body.password))) {
      if (u) {
        // Counted in the database, so many wrong guesses sent at once all count.
        const { failedLogins } = await prisma.user.update({ where: { id: u.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
        if (failedLogins >= LOCK_AFTER) await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() + LOCK_MS) } });
      }
      throw new ApiError(401, 'That email or phone and password don’t match.');
    }
    // Signing in within 30 days of asking to delete the account cancels the deletion.
    await prisma.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null, deleteOn: null } });
    if (u.deleteOn) await notify(u.id, { kind: 'entry', title: 'Account deletion cancelled', body: 'You signed in, so your account stays. Ask again from Settings any time.' });
    // Phone numbers aren't verified (no text messages); an email must be.
    const verified = identifier.includes('@') ? u.emailVerified : true;
    // Not verified yet: to the code screen, with the code just sent if there is one.
    if (!verified) return { kind: 'verify', identifier, code: await sendCode(identifier, 'verify', undefined, { reuseRecent: true }) };
    return { kind: 'signedIn', session: await startSession(u.id) };
  });

  app.post('/auth/code', async (req) => {
    const body = z.object({ identifier: z.string().min(3), purpose: z.enum(['verify', 'reset']) }).parse(req.body);
    const identifier = normalise(body.identifier);
    if (!identifier.includes('@')) throw badRequest(PHONE_CODES);
    // Resets answer the same way whether or not the account exists, so the form can't be used to find accounts.
    if (body.purpose === 'reset' && !(await findByIdentifier(identifier))) {
      return { channel: identifier.includes('@') ? 'email' : 'phone', destination: mask(identifier), expiresInSeconds: CODE_TTL_MS / 1000, resendInSeconds: RESEND_MS / 1000 } satisfies CodeSent;
    }
    return sendCode(identifier, body.purpose);
  });

  app.post('/auth/verify', async (req) => {
    const body = z.object({ identifier: z.string().min(3), code: z.string().length(6) }).parse(req.body);
    const identifier = normalise(body.identifier);
    const c = await checkCode(identifier, body.code, 'verify');
    // Adding a contact to a signed-in account, or verifying the one an account signed up with.
    const owner = c.userId ? { id: c.userId } : await findByIdentifier(identifier);
    if (!owner) throw new ApiError(404, 'Account not found');
    await prisma.user.update({ where: { id: owner.id }, data: identifier.includes('@') ? { email: identifier, emailVerified: true } : { phone: identifier, phoneVerified: true } });
    await createPendingOrganisation(owner.id);
    return startSession(owner.id);
  });

  app.post('/auth/reset-password', async (req) => {
    const body = z.object({ identifier: z.string().min(3), code: z.string().length(6), newPassword: z.string().min(8, 'Use a password of at least 8 characters') }).parse(req.body);
    const identifier = normalise(body.identifier);
    await checkCode(identifier, body.code, 'reset');
    const u = await findByIdentifier(identifier);
    if (!u) throw new ApiError(404, 'Account not found');
    await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(body.newPassword), failedLogins: 0, lockedUntil: null, ...(identifier.includes('@') ? { emailVerified: true } : { phoneVerified: true }) } });
    // A reset signs out every other device.
    await prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return startSession(u.id);
  });

  app.get('/auth/session', async (req) => {
    const user = requireUser(req);
    return { token: req.headers.authorization!.slice(7), user } satisfies AuthSession;
  });

  app.post('/auth/sign-out', async (req, reply) => {
    if (req.sessionHash) await prisma.session.update({ where: { tokenHash: req.sessionHash }, data: { revokedAt: new Date() } });
    return reply.status(204).send();
  });

  app.get('/me', async (req) => requireUser(req));

  app.patch('/me', async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        name: z.string().trim().min(1).optional(),
        city: z.string().optional(),
        dateOfBirth: dateOfBirth.optional(),
        settings: z.object({ dataSaver: z.boolean(), alerts: z.object({ push: z.boolean(), sms: z.boolean(), whatsapp: z.boolean() }), alertTopics: z.record(z.string(), z.boolean()), careerSetupDone: z.boolean().optional() }).optional(),
      })
      .parse(req.body);
    await prisma.user.update({
      where: { id: user.id },
      data: { ...(body.name ? { name: body.name } : {}), ...(body.city !== undefined ? { city: body.city || null } : {}), ...(body.dateOfBirth ? { dateOfBirth: new Date(body.dateOfBirth) } : {}), ...(body.settings ? { settings: toJson(body.settings) } : {}) },
    });
    if (body.dateOfBirth) await copyBirthDateToPlayers(user.id);
    return loadUser(user.id);
  });

  app.post('/me/contacts', async (req) => {
    const user = requireUser(req);
    const value = normalise(z.object({ value: z.string().min(3) }).parse(req.body).value);
    if (!isEmail(value) && !phoneRe.test(value)) throw badRequest('Enter an email, or a phone number with its country code');
    const other = await findByIdentifier(value);
    if (other && other.id !== user.id) throw conflict('Another account already uses that');
    // A phone number is saved as a contact (WhatsApp), unverified; an email is verified by code.
    if (!value.includes('@')) {
      await prisma.user.update({ where: { id: user.id }, data: { phone: value, phoneVerified: false } });
      return { identifier: value, user: await loadUser(user.id) };
    }
    return { identifier: value, code: await sendCode(value, 'verify', user.id) };
  });
}
