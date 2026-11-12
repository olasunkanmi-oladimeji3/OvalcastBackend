import { randomBytes } from 'node:crypto';

/** Short, URL-safe, sortable-enough ids such as `m_lx3k9a8f2q`. */
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
