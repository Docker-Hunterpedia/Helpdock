import {
  contacts,
  type DbTransaction,
  departments,
  teams,
  ticketStatuses,
  userBrandRoles,
  users,
} from '@helpdock/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { importAssigneeEligible } from './assignee-eligibility.js';
import { ImportLoadError, type TicketLoad } from './contracts.js';

/** Foreign keys alone do not prove that a mapping target belongs to this brand. */
export async function validateTicketMappings(
  tx: DbTransaction,
  input: TicketLoad,
): Promise<(typeof ticketStatuses.$inferSelect)['systemState']> {
  const { brandId, resolved } = input;
  const [department] = await tx
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.brandId, brandId), eq(departments.id, resolved.departmentId)));
  const [status] = await tx
    .select({ state: ticketStatuses.systemState })
    .from(ticketStatuses)
    .where(and(eq(ticketStatuses.brandId, brandId), eq(ticketStatuses.id, resolved.statusId)));
  if (!department || !status) throw new ImportLoadError('mapping-invalid');
  if (resolved.teamId) {
    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.brandId, brandId),
          eq(teams.id, resolved.teamId),
          eq(teams.departmentId, resolved.departmentId),
        ),
      );
    if (!team) throw new ImportLoadError('mapping-invalid');
  }
  if (resolved.contactId) {
    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.brandId, brandId),
          eq(contacts.id, resolved.contactId),
          isNull(contacts.anonymisedAt),
          isNull(contacts.mergedIntoId),
        ),
      );
    if (!contact) throw new ImportLoadError('mapping-invalid');
  }
  if (resolved.assigneeId) {
    const [membership] = await tx
      .select({
        role: userBrandRoles.role,
        status: users.status,
        departmentIds: userBrandRoles.departmentIds,
      })
      .from(userBrandRoles)
      .innerJoin(users, eq(users.id, userBrandRoles.userId))
      .where(
        and(
          eq(userBrandRoles.brandId, brandId),
          eq(userBrandRoles.userId, resolved.assigneeId),
          inArray(users.status, ['active', 'invited']),
        ),
      );
    if (!importAssigneeEligible(membership, resolved.departmentId))
      throw new ImportLoadError('mapping-invalid');
  }
  return status.state;
}
