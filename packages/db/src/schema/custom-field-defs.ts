import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { customFieldTargetEnum, customFieldTypeEnum } from './enums.js';

/**
 * What extra fields a brand keeps on its tickets, contacts and accounts
 * (REQUIREMENTS §4.1, M1-06). The *definitions* live here; the values live in
 * the `custom jsonb` column of the row they describe.
 *
 * Values in jsonb rather than an entity-attribute-value table because every
 * read of a ticket needs all of them and none of them is ever queried across
 * rows in v1 — a join per field would be paid on the list, which is the query
 * REQUIREMENTS §5.2 puts a number on. What jsonb gives up is the database
 * enforcing the shape, so `@helpdock/schemas/custom-fields` builds a Zod schema
 * from these rows and every write goes through it.
 *
 * `key` is immutable after creation, and that is the whole reason it exists
 * beside `label`: the label is what a person reads and may be corrected at any
 * time, while the key is what is already written into every stored value, every
 * template default and (from M3) every rule condition. Renaming it would
 * silently orphan all of them.
 */
export const customFieldDefs = pgTable(
  'custom_field_defs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    target: customFieldTargetEnum('target').notNull(),
    /** snake_case, immutable; the key inside the target's `custom` jsonb. */
    key: varchar('key', { length: 60 }).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    /** Arabic label. Null means the brand has not translated this field yet. */
    labelAr: varchar('label_ar', { length: 120 }),
    type: customFieldTypeEnum('type').notNull(),
    /**
     * The choices, for `select` and `multi_select`; empty for every other type.
     * An array of strings rather than rows of their own: a choice has no
     * identity beyond its text, it is stored by text in the values, and the
     * editor reorders the whole list at once.
     */
    options: jsonb('options').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    required: boolean('required').notNull().default(false),
    /**
     * Whether an Agent sees the field at all. Off is how a brand keeps a field
     * that only administrators and rules read; it is a display rule and never a
     * security boundary, because the value is in the same jsonb column either
     * way.
     */
    agentVisible: boolean('agent_visible').notNull().default(true),
    /** Position in this target's list. Dense and zero-based after every reorder. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // One key per target per brand: two definitions sharing a key would be two
  // meanings for one entry of the same jsonb object.
  (table) => [
    unique('custom_field_defs_brand_target_key').on(table.brandId, table.target, table.key),
  ],
);

export type CustomFieldDefRow = typeof customFieldDefs.$inferSelect;
export type NewCustomFieldDef = typeof customFieldDefs.$inferInsert;
