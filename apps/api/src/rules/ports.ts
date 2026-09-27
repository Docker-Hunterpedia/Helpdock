import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';

/**
 * What the rules engine needs from two other M3 deliverables, as interfaces,
 * so the engine is testable without them. Both are wired in two places,
 * `engine-deps.ts` for the worker and `rules.module.ts` for the builder: the
 * calendar through `sla/business-hours-probe.ts`, canned responses through
 * `macros/canned-response-port.ts`.
 */

/** What rendering a canned response gives back: sanitised by the owner, sanitised again here. */
export interface RenderedCannedResponse {
  readonly bodyHtml: string;
}

/**
 * M3-06's `CannedResponsesService.render(id, { locale, ticket })`. `tx` rides in
 * the options because the engine runs in a worker, where there is no request
 * transaction to reach through `getTx()`; the brand's system transaction is
 * the one to read the canned response through.
 *
 * `null` means "no such canned response in this brand", which the engine
 * records as an action it could not carry out rather than a failure of the run.
 */
export interface CannedResponseRenderer {
  render(
    id: string,
    options: { readonly locale: Locale; readonly ticket: TicketRow; readonly tx: DbTransaction },
  ): Promise<RenderedCannedResponse | null>;
}

/**
 * M3-01's calendar, asked through `BusinessHoursService.calendarFor(brandId,
 * departmentId)` and `isWithinBusinessHours(calendar, at)`. The rules engine
 * needs one answer for one department at one moment. `businessHoursProbe` in
 * `sla/business-hours-probe.ts` is the implementation, shared with M2-06's
 * out-of-hours reply.
 */
export interface BusinessHoursProbe {
  isOpen(
    tx: DbTransaction,
    options: { readonly brandId: string; readonly departmentId: string; readonly at: Date },
  ): Promise<boolean>;
}

/** What the builder lists as canned responses: M3-06's, by name. */
export interface CannedResponseCatalog {
  list(tx: DbTransaction): Promise<{ readonly id: string; readonly name: string }[]>;
}
