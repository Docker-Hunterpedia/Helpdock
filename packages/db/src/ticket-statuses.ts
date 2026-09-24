import type { DbTransaction } from './client.js';
import { ticketStatuses } from './schema/ticket-statuses.js';

/**
 * The statuses every brand starts with (DOMAIN-RULES §2.1, §2.2, §2.4).
 *
 * Four of them are the system states themselves, so a brand that adds nothing
 * can still work a ticket end to end. Two are the custom statuses §2.1 says
 * ship with every brand — Awaiting customer and Spam — and one more, Merged,
 * is what §2.4 closes the secondary of a merge into.
 *
 * `key` is not a column. It is how *code* names the row it needs: the reopen
 * path wants the default open status, merge wants Merged, spam wants Spam. The
 * columns those paths actually read are `is_default`, `system_state` and the
 * flags, so a brand renaming "Open" to "New" changes a label and nothing else.
 *
 * `excluded_from_reports` is the fourth such flag, added by M1-08: §2.1 words
 * Spam as "closed, excluded from reports" and §2.4 says the same of Merged, and
 * §2.2 makes it the reason a close schedules no CSAT. Without it, "is this the
 * Spam status?" could only be answered by the row's name, which a brand may
 * change.
 *
 * `is_spam` is the fifth, added by M1-14: Merged carries the same flags as
 * Spam, and DOMAIN-RULES §11 purges spam on a clock of its own.
 */
export const BUILT_IN_TICKET_STATUSES = [
  {
    key: 'open',
    name: 'Open',
    nameAr: 'مفتوحة',
    systemState: 'open',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: true,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 10,
    color: 'info',
  },
  {
    key: 'awaiting_customer',
    name: 'Awaiting customer',
    nameAr: 'بانتظار العميل',
    systemState: 'on_hold',
    pausesSla: true,
    awaitingCustomer: true,
    isDefault: false,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 20,
    color: 'warning',
  },
  {
    key: 'escalated',
    name: 'Escalated',
    nameAr: 'مُصعَّدة',
    systemState: 'escalated',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 30,
    color: 'escalated',
  },
  {
    key: 'closed',
    name: 'Closed',
    nameAr: 'مغلقة',
    systemState: 'closed',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    excludedFromReports: false,
    isSpam: false,
    sortOrder: 40,
    color: 'success',
  },
  {
    key: 'spam',
    name: 'Spam',
    nameAr: 'بريد مزعج',
    systemState: 'closed',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    excludedFromReports: true,
    isSpam: true,
    sortOrder: 50,
    color: 'danger',
  },
  {
    key: 'merged',
    name: 'Merged',
    nameAr: 'مدمجة',
    systemState: 'closed',
    pausesSla: false,
    awaitingCustomer: false,
    isDefault: false,
    excludedFromReports: true,
    isSpam: false,
    sortOrder: 60,
    color: 'success',
  },
] as const;

export type BuiltInTicketStatusKey = (typeof BUILT_IN_TICKET_STATUSES)[number]['key'];

/** The one status a new or reopened ticket lands in (DOMAIN-RULES §2.2). */
export const DEFAULT_TICKET_STATUS_KEY: BuiltInTicketStatusKey = 'open';

/**
 * Writes the built-in statuses for a brand, through the caller's transaction.
 *
 * It is called by whatever creates a brand — the first-run wizard today, the
 * brand service of M1-01 tomorrow — rather than by a trigger, because the rows
 * are data and the runtime role writes data. `onConflictDoNothing` on
 * `(brand_id, name)` makes it idempotent, so a brand creation that is retried,
 * or a second caller added later, leaves one set of statuses.
 *
 * `tx` must be the transaction that created the brand: a brand that committed
 * without its statuses would be a brand no ticket can be filed in.
 */
export const seedBrandStatuses = async (tx: DbTransaction, brandId: string): Promise<void> => {
  await tx
    .insert(ticketStatuses)
    .values(
      BUILT_IN_TICKET_STATUSES.map(({ key: _key, ...status }) => ({
        ...status,
        brandId,
        isSystem: true,
      })),
    )
    .onConflictDoNothing({ target: [ticketStatuses.brandId, ticketStatuses.name] });
};
