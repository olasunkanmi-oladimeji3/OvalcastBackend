import type { User } from '@/api/types';
import { prisma } from '~/db/client';
import { newId } from './ids';

/** Records what a staff member did from the backoffice, for the activity log and the user's page. */
export async function logStaff(staff: User, action: string, targetKind: string, targetId?: string, note?: string) {
  await prisma.staffAction.create({ data: { id: newId('sa'), staffId: staff.id, staffName: staff.name, action, targetKind, targetId: targetId ?? null, note: note ?? null } });
}
