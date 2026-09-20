import type { TicketStatus as TicketStatusRow } from '@helpdock/db';
import type { TicketingRefusal, TicketStatusUpdateRequest } from '@helpdock/schemas';

/**
 * What may be done to a status row, as pure functions of values the caller has
 * already read.
 *
 * They are apart from the service for the reason `brands/department-scope.ts`
 * gives: the rules are the interesting part, they are the part a reviewer wants
 * to read next to DOMAIN-RULES, and a rule that needs a database to be tested
 * is a rule that gets tested once.
 *
 * The rules themselves come from two places. §2.1 and `ticket-statuses.ts`
 * define six seeded rows that code refers to by what they *are* — the default
 * open status, Awaiting customer, Spam, Merged — so their state and flags are
 * fixed and only their label may change. §2.2 makes the default the status a
 * new or reopened ticket lands in, so it has to be open-like or a reopen would
 * close the ticket it just revived.
 */

/** The fields of a `PATCH` that a **system** row will not accept. */
const FIXED_ON_SYSTEM_ROWS = ['systemState', 'pausesSla', 'awaitingCustomer'] as const;

/**
 * `null` when the edit is allowed.
 *
 * A system row may be renamed, recoloured and made the default; its system
 * state and its two flags are what `awaitingCustomerStatus()` and the reopen
 * path find it by, so changing them would rename the concept rather than the
 * label.
 */
export const statusEditRefusal = (
  status: TicketStatusRow,
  request: TicketStatusUpdateRequest,
): TicketingRefusal | null => {
  if (status.isSystem && FIXED_ON_SYSTEM_ROWS.some((field) => request[field] !== undefined)) {
    return 'status-state-fixed';
  }

  // The default is where a new ticket lands and where a reopen returns a ticket
  // to (§2.2). A closed or on-hold default would mean a ticket that is created
  // already finished, or a reopen that closes.
  const nextState = request.systemState ?? status.systemState;
  if (request.isDefault === true && nextState !== 'open') {
    return 'default-must-be-open';
  }

  // Moving the brand's only default off `open` by editing the row it sits on is
  // the same mistake arriving from the other direction.
  if (status.isDefault && request.systemState !== undefined && request.systemState !== 'open') {
    return 'default-must-be-open';
  }

  return null;
};

/**
 * `null` when the status may be deleted.
 *
 * Two rows refuse. A seeded one is referred to by code and has no replacement
 * (`packages/db/src/ticket-statuses.ts`), and the default is where every new
 * ticket lands — another row has to be made the default first, which is a
 * deliberate second step rather than a silent reassignment.
 */
export const statusDeleteRefusal = (status: TicketStatusRow): TicketingRefusal | null => {
  if (status.isSystem) {
    return 'status-is-system';
  }
  if (status.isDefault) {
    return 'status-is-default';
  }

  return null;
};
