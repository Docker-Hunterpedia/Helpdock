import { type DbTransaction, userBrandRoles, users } from '@helpdock/db';
import { and, eq } from 'drizzle-orm';

export async function importedStaffMembership(tx: DbTransaction, brandId: string, userId: string) {
  const [member] = await tx
    .select({
      role: userBrandRoles.role,
      status: users.status,
      departmentIds: userBrandRoles.departmentIds,
    })
    .from(userBrandRoles)
    .innerJoin(users, eq(users.id, userBrandRoles.userId))
    .where(and(eq(userBrandRoles.brandId, brandId), eq(userBrandRoles.userId, userId)));
  return member;
}
