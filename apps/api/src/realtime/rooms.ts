import { type DepartmentScope, parseRoom, type SocketError } from '@helpdock/schemas';
import type { StaffPrincipal } from './socket.js';

/**
 * Which rooms a principal may join (DOMAIN-RULES §1.4: "joining a room runs the
 * same permission check as the corresponding REST read").
 *
 * The permission itself — does this principal hold a role in this brand at all
 * — is the {@link ../auth/permission.guard.js PermissionGuard}'s answer, and it
 * has already said yes by the time this runs. What is left is the part the
 * database enforces for HTTP: the department scope of DOMAIN-RULES §1.3 layer
 * 3, which no row-level security policy can enforce for a room name.
 */

export type RoomAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SocketError };

const refuse = (message: string): RoomAuthorization => ({
  ok: false,
  error: { code: 'forbidden', message },
});

const malformed = (message: string): RoomAuthorization => ({
  ok: false,
  error: { code: 'invalid_payload', message },
});

/**
 * The principal's department scope in one brand, or `undefined` when it holds
 * no role there. `'all'` is an Admin, or a Team Leader or Viewer with no
 * restriction (DOMAIN-RULES §1.1).
 */
const departmentScopeOf = (
  principal: StaffPrincipal,
  brandId: string,
): DepartmentScope | undefined => principal.brands[brandId]?.departmentIds;

export interface AuthorizeRoomInput {
  readonly principal: StaffPrincipal;
  /** The brand the join named, already checked by the permission guard. */
  readonly brandId: string;
  readonly room: string;
}

export const authorizeRoom = ({
  principal,
  brandId,
  room,
}: AuthorizeRoomInput): RoomAuthorization => {
  const parsed = parseRoom(room);
  if (parsed === null) {
    return malformed('A room is <kind>:<uuid>');
  }

  const scope = departmentScopeOf(principal, brandId);
  if (scope === undefined) {
    return refuse('You hold no role in that brand');
  }

  switch (parsed.kind) {
    case 'brand':
      // The guard checked `brand:read` in `brandId`; the room has to be that
      // same brand, or a member of brand A could listen to brand B by naming A.
      return parsed.id === brandId ? { ok: true } : refuse('That room belongs to another brand');
    case 'department':
      // A room name carries no brand, and `'all'` means "every department *of
      // that brand*" (DOMAIN-RULES §1.1). Without a departments table — M1
      // creates it — nothing can prove a department belongs to `brandId`, so an
      // unrestricted scope has no way to be checked and is refused rather than
      // waved through. An explicit list needs no table: the list itself is
      // per-brand, so membership proves both the brand and the scope.
      return Array.isArray(scope) && scope.includes(parsed.id)
        ? { ok: true }
        : refuse(
            scope === 'all'
              ? 'Unrestricted department rooms arrive with milestone M1'
              : 'That department is outside your scope',
          );
    case 'ticket':
      // M1 owns tickets. Until the table exists there is nothing to check
      // against, and "no check" may never mean "allowed" (DOMAIN-RULES §1.3).
      return refuse('Ticket rooms arrive with milestone M1');
  }
};
