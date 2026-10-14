import type { userBrandRoles, users } from '@helpdock/db';

type Membership = {
  role: typeof userBrandRoles.$inferSelect.role;
  status: typeof users.$inferSelect.status;
  departmentIds: readonly string[] | null;
};

/** Both preview and loading enforce department eligibility, including invited staff. */
export function importAssigneeEligible(
  member: Membership | undefined,
  departmentId: string,
): boolean {
  return (
    member !== undefined &&
    ['active', 'invited'].includes(member.status) &&
    member.role !== 'viewer' &&
    (member.departmentIds === null || member.departmentIds.includes(departmentId))
  );
}
