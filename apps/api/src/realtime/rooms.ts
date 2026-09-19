import { type DepartmentScope, parseRoom, type SocketError } from '@helpdock/schemas';
import { principalHasPermission } from '../auth/permissions.js';
import type { RoomScopeQuery, RoomScopeReader } from './room-reader.js';
import type { StaffPrincipal } from './socket.js';

/**
 * Which rooms a principal may join (DOMAIN-RULES §1.4: "joining a room runs the
 * same permission check as the corresponding REST read").
 *
 * The permission itself — does this principal hold a role in this brand at all
 * — is the {@link ../auth/permission.guard.js PermissionGuard}'s answer, and it
 * has already said yes by the time this runs. What is left is the part the
 * database enforces for HTTP: the department scope of DOMAIN-RULES §1.3 layer
 * 3, which no row-level security policy can enforce for a room *name*.
 *
 * Two of the three kinds are decided without touching the database, and one
 * cannot be. A `ticket:` room names a row, and the only honest answer to
 * "may this principal join it" is the one the policies give
 * ({@link ./room-reader.js RoomScopeReader}), so this function is async.
 */

export type RoomAuthorization =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SocketError };

const ALLOWED: RoomAuthorization = { ok: true };

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
  readonly reader: RoomScopeReader;
}

export const authorizeRoom = async ({
  principal,
  brandId,
  room,
  reader,
}: AuthorizeRoomInput): Promise<RoomAuthorization> => {
  const parsed = parseRoom(room);
  if (parsed === null) {
    return malformed('A room is <kind>:<uuid>');
  }

  const scope = departmentScopeOf(principal, brandId);
  if (scope === undefined) {
    return refuse('You hold no role in that brand');
  }

  const query = { brandId, departmentIds: scope, principalId: principal.id };

  switch (parsed.kind) {
    case 'brand':
      // The guard checked `brand:read` in `brandId`; the room has to be that
      // same brand, or a member of brand A could listen to brand B by naming A.
      return parsed.id === brandId ? ALLOWED : refuse('That room belongs to another brand');
    case 'department':
    case 'ticket': {
      // "Joining a room runs the same permission check as the corresponding
      // REST read" (§1.4). The join itself is declared `brand:read`, because
      // that is what a `brand:` room needs; these two mirror routes that
      // declare `ticket:read`, and every role that holds one holds the other
      // *today*. Asking anyway is what keeps that from becoming a silent
      // subscription the next role can make and not fetch.
      if (!principalHasPermission(principal, brandId, 'ticket:read')) {
        return refuse('You may not read tickets in that brand');
      }

      return parsed.kind === 'department'
        ? departmentRoomFor(scope, query, parsed.id, reader)
        : ticketRoomFor(query, parsed.id, reader);
    }
  }
};

/**
 * An explicit list needs no query: the list is itself per-brand, so membership
 * proves both the brand and the scope. `'all'` does need one — a room name
 * carries no brand, and `'all'` means "every department *of that brand*" — so
 * the departments table is asked.
 */
const departmentRoomFor = async (
  scope: DepartmentScope,
  query: RoomScopeQuery,
  departmentId: string,
  reader: RoomScopeReader,
): Promise<RoomAuthorization> => {
  if (Array.isArray(scope)) {
    return scope.includes(departmentId) ? ALLOWED : refuse('That department is outside your scope');
  }

  return (await reader.departmentInScope({ ...query, departmentId }))
    ? ALLOWED
    : refuse('That department is outside your scope');
};

/**
 * The same question `GET /api/brands/:brandId/tickets/:ticketId` asks, asked the
 * same way: the policies decide, so "no such ticket for you" and "no such
 * ticket" are one answer and neither confirms the other department's ticket
 * exists.
 */
const ticketRoomFor = async (
  query: RoomScopeQuery,
  ticketId: string,
  reader: RoomScopeReader,
): Promise<RoomAuthorization> =>
  (await reader.ticketInScope({ ...query, ticketId }))
    ? ALLOWED
    : refuse('That ticket is outside your scope');
