import type { Department as DepartmentRow } from '@helpdock/db';
import type { Department, StaffMember, StaffStatus } from '@helpdock/schemas';
import { toClientRole } from '../auth/session-view.js';
import type { PendingInvite } from './invite.store.js';
import { departmentScopeOf } from './roles.js';
import type { StaffRow } from './staff.repository.js';

/**
 * A membership and its account, as one row of the staff table.
 *
 * Departments are resolved to names here rather than in the browser: the cell
 * prints names, and a table that fetched ids and then looked them up would have
 * a frame in which it knew a person's scope but could not say what it was.
 *
 * An id with no department behind it is dropped. That happens when a department
 * is deleted while somebody is still assigned to it; showing a bare uuid would
 * be worse than showing one fewer chip, and the scope itself is still whatever
 * row-level security makes of the column.
 */

export interface StaffViewInput {
  readonly row: StaffRow;
  readonly departments: ReadonlyMap<string, DepartmentRow>;
  /** The outstanding invitation, when this person has not signed in yet. */
  readonly pendingInvite: PendingInvite | null;
  /** Seconds since the epoch, from the newest refresh family they hold. */
  readonly lastActiveAt: number | null;
  /** The person reading the list. Their own row offers no actions. */
  readonly viewerId: string;
}

const isoOrNull = (value: Date | null): string | null => value?.toISOString() ?? null;

export const toStaffMember = ({
  row,
  departments,
  pendingInvite,
  lastActiveAt,
  viewerId,
}: StaffViewInput): StaffMember => {
  const scope = departmentScopeOf(row.membership.departmentIds);
  const assigned: Department[] =
    scope === 'all'
      ? []
      : scope
          .map((id) => departments.get(id))
          .filter((department) => department !== undefined)
          .map((department) => ({ id: department.id, name: department.name }));

  // A pending invitation only means anything while the account has never been
  // used; an active person with a stale Redis record is active.
  const invited = row.user.status === 'invited' && pendingInvite !== null;

  return {
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: toClientRole(row.membership.role),
    departments: scope === 'all' ? 'all' : assigned,
    status: row.user.status as StaffStatus,
    twoFactorEnabled: row.user.totpEnabled,
    installAdmin: row.user.installAdmin,
    lastActiveAt: lastActiveAt === null ? null : new Date(lastActiveAt * 1000).toISOString(),
    invitedAt: invited ? new Date(pendingInvite.issuedAt).toISOString() : null,
    invitationExpiresAt: invited ? new Date(pendingInvite.expiresAt).toISOString() : null,
    deactivatedAt: isoOrNull(row.user.deactivatedAt),
    self: row.user.id === viewerId,
  };
};
