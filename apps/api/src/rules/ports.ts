import type { DbTransaction, Ticket as TicketRow } from '@helpdock/db';
import type { Locale } from '@helpdock/i18n';

/**
 * What the rules engine needs from two other M3 deliverables, as interfaces,
 * so M3-03 is buildable and testable before they land and each is wired in one
 * place (`worker/start-worker.ts`, `rules.module.ts`) when they do.
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
 * Until M3-06 is wired, every canned response is unavailable: a rule that
 * sends one records the action as not carried out and does the rest.
 */
export const noCannedResponses: CannedResponseRenderer = {
  render: () => Promise.resolve(null),
};

/**
 * M3-01's calendar, asked through `BusinessHoursService.calendarFor(brandId,
 * departmentId)` and `isWithinBusinessHours(calendar, at)`. The rules engine
 * needs one answer for one department at one moment.
 */
export interface BusinessHoursProbe {
  isOpen(
    tx: DbTransaction,
    options: { readonly brandId: string; readonly departmentId: string; readonly at: Date },
  ): Promise<boolean>;
}

/** Until M3-01 is wired, every department is open, which is how M1 already behaves. */
export const alwaysOpen: BusinessHoursProbe = {
  isOpen: () => Promise.resolve(true),
};

/** What the builder lists as canned responses: M3-06's, by name. */
export interface CannedResponseCatalog {
  list(tx: DbTransaction): Promise<{ readonly id: string; readonly name: string }[]>;
}

/** Until M3-06 is wired, the builder offers no canned responses. */
export const noCannedResponseCatalog: CannedResponseCatalog = {
  list: () => Promise.resolve([]),
};
