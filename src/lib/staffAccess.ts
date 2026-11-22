// Who gets into the backoffice, set from the server's environment so the first staff member can be
// added without touching the database by hand.
import { prisma } from '~/db/client';

/** Marks the accounts with these emails (comma-separated) as staff. Returns how many changed. */
export async function grantStaff(list: string | undefined) {
  const emails = (list ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@'));
  if (!emails.length) return 0;
  const r = await prisma.user.updateMany({ where: { email: { in: emails }, staff: false }, data: { staff: true } });
  return r.count;
}
