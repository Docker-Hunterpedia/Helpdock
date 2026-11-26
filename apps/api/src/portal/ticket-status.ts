/**
 * The four words a customer reads for a ticket's state (M21-03, artboard
 * `HelpCenter/Portal-Tickets`). The desk's own statuses are the brand's to name
 * and a customer must not see them, so the page shows one of these whatever the
 * brand called its statuses.
 */
export const CUSTOMER_STATUSES = ['open', 'waiting_you', 'waiting_us', 'solved'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** What a status row says, as far as a customer's word goes. Nothing else of it is read. */
export interface StatusFacts {
  readonly systemState: 'open' | 'on_hold' | 'escalated' | 'closed';
  readonly awaitingCustomer: boolean;
}

/**
 * - closed, by status or by `closed_at`: **Solved**;
 * - the ball is with the customer: **Waiting for you**;
 * - snoozed: **Waiting for us**, whatever the status it will wake into;
 * - an open ticket: **Open**;
 * - anything else that is not closed (on hold, escalated): **Waiting for us**.
 *
 * A status the lookup did not find reads as Waiting for us rather than failing
 * the page: it is the least committal of the four.
 */
export const customerStatusOf = (input: {
  readonly status: StatusFacts | undefined;
  readonly closed: boolean;
  readonly snoozed: boolean;
}): CustomerStatus => {
  const { status } = input;
  if (input.closed || status?.systemState === 'closed') {
    return 'solved';
  }
  if (status?.awaitingCustomer === true) {
    return 'waiting_you';
  }
  if (input.snoozed) {
    return 'waiting_us';
  }
  return status?.systemState === 'open' ? 'open' : 'waiting_us';
};
