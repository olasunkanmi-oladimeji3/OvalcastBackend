// Phone notifications through Expo's push service: every in-app notification also buzzes the
// person's phones, unless they turned push off in their alert settings. Tokens Expo reports as
// unregistered (the app was uninstalled) are removed.
//
// On only in production, or with PUSH_ENABLED=true. EXPO_ACCESS_TOKEN is sent when set (Expo's
// "enhanced security for push" option).

import { prisma } from '~/db/client';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
export const pushEnabled = () => process.env.PUSH_ENABLED === 'true' || (process.env.NODE_ENV === 'production' && process.env.PUSH_ENABLED !== 'false');

export const isExpoToken = (t: string) => /^(Exponent|Expo)PushToken\[[\w-]+\]$/.test(t);

type Message = { title: string; body: string; data?: Record<string, unknown> };

/** Sends to each person's phones. Never throws: a notification already saved in the app is enough. */
export async function sendPush(userIds: string[], msg: Message): Promise<number> {
  if (!pushEnabled() || !userIds.length) return 0;
  try {
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, settings: true } });
    const wanting = users.filter((u) => (u.settings as { alerts?: { push?: boolean } } | null)?.alerts?.push !== false).map((u) => u.id);
    if (!wanting.length) return 0;
    const tokens = await prisma.pushToken.findMany({ where: { userId: { in: wanting } }, select: { token: true } });
    let sent = 0;
    for (let i = 0; i < tokens.length; i += 100) {
      const batch = tokens.slice(i, i + 100);
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(batch.map((t) => ({ to: t.token, title: msg.title, body: msg.body, data: msg.data ?? {}, sound: 'default', channelId: 'default', priority: 'high' }))),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const out = (await res.json()) as { data?: { status: 'ok' | 'error'; details?: { error?: string } }[] };
      const gone = (out.data ?? []).map((r, j) => (r.status === 'error' && r.details?.error === 'DeviceNotRegistered' ? batch[j].token : undefined)).filter((t): t is string => !!t);
      if (gone.length) await prisma.pushToken.deleteMany({ where: { token: { in: gone } } });
      sent += (out.data ?? []).filter((r) => r.status === 'ok').length;
    }
    return sent;
  } catch {
    return 0;
  }
}
