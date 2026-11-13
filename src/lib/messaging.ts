// Sends verification codes by SMS or email.
//
// SMS_PROVIDER: termii (Africa-wide, the default choice for West Africa) or twilio (worldwide).
// EMAIL_PROVIDER: postmark or resend. Unset, codes are printed to the server log, which is only
// for development: in production the server refuses to start without real providers (see config.ts).

export interface Messenger {
  sendCode(to: string, code: string, purpose: 'verify' | 'reset'): Promise<void>;
  /** Any other email (club invitations): plain text, from EMAIL_FROM. Logged instead when no provider is set. */
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

const text = (code: string, purpose: 'verify' | 'reset') =>
  purpose === 'verify' ? `Your Ovalcast code is ${code}. It expires in 10 minutes. Don't share it with anyone.` : `Your Ovalcast password reset code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.`;

/** Fails with the provider's reason, so the log says why a code didn't go. */
async function post(url: string, init: RequestInit, provider: string) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${provider} refused the message: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ------------------------------------------------------------------ SMS

const termii = (to: string, body: string) =>
  post(
    `${process.env.TERMII_BASE_URL ?? 'https://api.ng.termii.com'}/api/sms/send`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The "dnd" route reaches numbers on Do-Not-Disturb, which most Nigerian lines are; it needs an approved sender ID.
      body: JSON.stringify({ api_key: process.env.TERMII_API_KEY, to: to.replace(/^\+/, ''), from: process.env.TERMII_SENDER_ID ?? 'Ovalcast', sms: body, type: 'plain', channel: process.env.TERMII_CHANNEL ?? 'dnd' }),
    },
    'Termii',
  );

const twilio = (to: string, body: string) =>
  post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM ?? '', Body: body }),
    },
    'Twilio',
  );

// ------------------------------------------------------------------ email

const subject = (purpose: 'verify' | 'reset') => (purpose === 'verify' ? 'Your Ovalcast code' : 'Reset your Ovalcast password');

const postmark = (to: string, subjectLine: string, body: string) =>
  post(
    'https://api.postmarkapp.com/email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN ?? '' },
      body: JSON.stringify({ From: process.env.EMAIL_FROM, To: to, Subject: subjectLine, TextBody: body, MessageStream: 'outbound' }),
    },
    'Postmark',
  );

const resend = (to: string, subjectLine: string, body: string) =>
  post(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject: subjectLine, text: body }),
    },
    'Resend',
  );

// ------------------------------------------------------------------ choosing

export const smsProvider = () => (process.env.SMS_PROVIDER === 'termii' || process.env.SMS_PROVIDER === 'twilio' ? process.env.SMS_PROVIDER : 'console');
export const emailProvider = () => (process.env.EMAIL_PROVIDER === 'postmark' || process.env.EMAIL_PROVIDER === 'resend' ? process.env.EMAIL_PROVIDER : 'console');

export const messenger: Messenger = {
  async sendCode(to, code, purpose) {
    const body = text(code, purpose);
    if (to.includes('@')) {
      const p = emailProvider();
      if (p === 'postmark') return postmark(to, subject(purpose), body);
      if (p === 'resend') return resend(to, subject(purpose), body);
    } else {
      const p = smsProvider();
      if (p === 'termii') return termii(to, body);
      if (p === 'twilio') return twilio(to, body);
    }
    console.log(`[messaging] ${purpose} code for ${to}: ${code}`);
  },
  async sendEmail(to, subjectLine, body) {
    const p = emailProvider();
    if (p === 'postmark') return postmark(to, subjectLine, body);
    if (p === 'resend') return resend(to, subjectLine, body);
    console.log(`[messaging] email to ${to}: ${subjectLine}\n${body}`);
  },
};
