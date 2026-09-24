import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { statusColorEnum, ticketSystemStateEnum } from './enums.js';

/**
 * The statuses one brand offers (DOMAIN-RULES §2.1). Four system states are
 * fixed; the statuses a person picks from are rows, so a brand can add
 * "Waiting on supplier" without the SLA engine or the reports learning a new
 * word — every row maps to one of the four.
 *
 * Brand-scoped, not department-scoped: a status list belongs to the brand, and
 * an Agent in one department has to be able to read the name of the status a
 * ticket in their own department is in.
 *
 * `is_system` marks the six rows {@link ../ticket-statuses.js seedBrandStatuses}
 * writes for every brand. They may be renamed and recoloured but never deleted,
 * because code refers to them: the reopen path needs the default open status,
 * merge needs Merged, and spam needs Spam (DOMAIN-RULES §2.2, §2.4).
 */
export const ticketStatuses = pgTable(
  'ticket_statuses',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 60 }).notNull(),
    /** Arabic label. Null means the brand has not translated this status yet. */
    nameAr: varchar('name_ar', { length: 60 }),
    systemState: ticketSystemStateEnum('system_state').notNull(),
    /** While a ticket is in this status, both SLA clocks are paused (§3.2). */
    pausesSla: boolean('pauses_sla').notNull().default(false),
    /** The ball is with the customer; time-based rules and reports read it (§2.1). */
    awaitingCustomer: boolean('awaiting_customer').notNull().default(false),
    /** The status a new or reopened ticket lands in. One per brand. */
    isDefault: boolean('is_default').notNull().default(false),
    /** Seeded with the brand and undeletable; see the note above. */
    isSystem: boolean('is_system').notNull().default(false),
    /**
     * "Spam (`closed`, excluded from reports)" — DOMAIN-RULES §2.1, and §2.4
     * says the same of Merged. A ticket closed into such a status is not a
     * resolution: no CSAT is scheduled for it (§2.2) and reporting leaves it
     * out.
     *
     * A flag rather than a name, because a brand may rename Spam and code must
     * still know what the row means — the same reasoning `is_default` and
     * `awaiting_customer` are already written with.
     */
    excludedFromReports: boolean('excluded_from_reports').notNull().default(false),
    /**
     * The row "Mark as spam" moves a ticket to (DOMAIN-RULES §2.2, M1-11). One
     * per brand, set on the seeded Spam row and nowhere else.
     *
     * `excluded_from_reports` alone cannot say it, because Merged carries that
     * flag too, and the name cannot say it because a brand may rename Spam.
     * Everything that treats spam differently — no auto-responder, no CSAT, no
     * round-robin count, no report — reads this through `isSpamStatus`.
     *
     * M1-14 reads it too: DOMAIN-RULES §11 purges spam after 30 days and a
     * merged ticket with the closed tickets, so retention cannot key off the
     * shared `excluded_from_reports` either.
     */
    isSpam: boolean('is_spam').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    color: statusColorEnum('color').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Two statuses of one brand with the same name would be indistinguishable in
  // the status picker, which is the only place anybody chooses one.
  (table) => [
    unique('ticket_statuses_brand_name_key').on(table.brandId, table.name),
    // "Which row is Spam?" has to have one answer per brand.
    uniqueIndex('ticket_statuses_brand_spam_key').on(table.brandId).where(sql`${table.isSpam}`),
  ],
);

export type TicketStatus = typeof ticketStatuses.$inferSelect;
export type NewTicketStatus = typeof ticketStatuses.$inferInsert;
