// A record of every money movement and payout-account change: who, what, and from which device,
// network and browser. Staff read it when something looks wrong (a stolen login, a disputed payout).
import type { FastifyRequest } from 'fastify';
import { prisma } from '~/db/client';
import { newId } from './ids';

export async function logMoney(req: FastifyRequest, entry: { userId: string; orgId?: string; action: 'withdrawal' | 'payoutAccount' | 'markedPaid'; amount?: number; currency?: string; reference?: string; detail?: string }) {
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.slice(0, 200);
  };
  await prisma.moneyLog.create({
    data: { id: newId('ml'), ...entry, orgId: entry.orgId ?? null, deviceId: header('x-device-id') ?? null, ip: req.ip ?? null, userAgent: header('user-agent') ?? null },
  });
}
