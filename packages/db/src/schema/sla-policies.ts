import { index, integer, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { slaTimeModeEnum } from './enums.js';
import { users } from './users.js';

/**
 * A brand's SLA policies (M3-02, DOMAIN-RULES §3), checked in `position` order;
 * the first whose conditions all match a ticket applies to it.
 *
 * Conditions, targets and escalation steps are JSON validated by the policy
 * schemas in `@helpdock/schemas`: they are read whole with the policy, never
 * queried into, and a column per priority would be eight columns that only
 * ever move together.
 *
 * Brand-scoped: a policy may name departments, but which department a Team
 * Leader may configure is a service rule, as it is for `teams`.
 */
export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }).notNull(),
    position: integer('position').notNull().default(0),
    conditions: jsonb('conditions').$type<unknown[]>().notNull(),
    timeMode: slaTimeModeEnum('time_mode').notNull().default('business'),
    targets: jsonb('targets').$type<Record<string, unknown>>().notNull(),
    escalation: jsonb('escalation').$type<unknown[]>().notNull(),
    updatedById: uuid('updated_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('sla_policies_brand_position_idx').on(table.brandId, table.position)],
);

export type SlaPolicyRow = typeof slaPolicies.$inferSelect;
export type NewSlaPolicyRow = typeof slaPolicies.$inferInsert;
