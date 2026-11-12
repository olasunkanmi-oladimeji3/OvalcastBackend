// Secrets kept in the database (YouTube stream keys) are encrypted with
// AES-256-GCM under SECRETS_KEY, a 32-byte key in base64 from the secret store.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key() {
  const k = process.env.SECRETS_KEY;
  if (k) return Buffer.from(k, 'base64');
  if (process.env.NODE_ENV === 'production') throw new Error('SECRETS_KEY is not set');
  return createHash('sha256').update('ovalcast-development-only').digest();
}

export function seal(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function open(sealed: string) {
  const [iv, tag, body] = sealed.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
