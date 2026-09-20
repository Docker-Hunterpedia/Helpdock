import {
  accounts,
  type CustomFieldDefRow,
  contacts,
  customFieldDefs,
  type DbTransaction,
  type NewCustomFieldDef,
  tickets,
} from '@helpdock/db';
import type { CustomFieldTarget } from '@helpdock/schemas';
import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Every statement the custom field endpoints make.
 *
 * Two halves. The definitions are ordinary rows in `custom_field_defs`. The
 * *values* are entries in a `custom jsonb` column on three other tables, so
 * counting how much depends on a definition — and clearing an option somebody
 * decided to remove anyway — is jsonb work, and it is all here rather than
 * spread through the service.
 *
 * Nothing filters by brand: the request's transaction carries `app.brand_ids`
 * and the policies apply it. `tickets` is additionally department-scoped, so a
 * usage count over tickets is "tickets you can see", which for the Admin who
 * usually holds `ticketing:manage` is every ticket in the brand and for a
 * restricted Team Leader is the ones they lead. That is the honest answer;
 * reaching past the department policy to count rows the reader may not know
 * exist would not be.
 */

/** The table and the jsonb column each target keeps its values in. */
const VALUE_COLUMN: Readonly<Record<CustomFieldTarget, { table: PgTable; column: PgColumn }>> = {
  ticket: { table: tickets, column: tickets.custom },
  contact: { table: contacts, column: contacts.custom },
  account: { table: accounts, column: accounts.custom },
};

export interface FieldUsage {
  /** Rows of the target that carry any value for this key. */
  readonly rows: number;
  /** Rows per option, for the choice types. Options nobody uses are absent. */
  readonly optionRows: Record<string, number>;
}

const countOf = async (tx: DbTransaction, table: PgTable, where: SQL): Promise<number> => {
  const rows = await tx.select({ count: sql<number>`count(*)::int` }).from(table).where(where);

  return rows[0]?.count ?? 0;
};

export class CustomFieldsRepository {
  async list(
    tx: DbTransaction,
    target?: CustomFieldTarget | undefined,
  ): Promise<CustomFieldDefRow[]> {
    const rows = await tx
      .select()
      .from(customFieldDefs)
      .where(target === undefined ? undefined : eq(customFieldDefs.target, target))
      .orderBy(
        asc(customFieldDefs.target),
        asc(customFieldDefs.sortOrder),
        asc(customFieldDefs.key),
      );

    return rows;
  }

  /** Undefined when the id is not this brand's, which the policy decides. */
  async find(tx: DbTransaction, fieldId: string): Promise<CustomFieldDefRow | undefined> {
    const rows = await tx
      .select()
      .from(customFieldDefs)
      .where(eq(customFieldDefs.id, fieldId))
      .limit(1);

    return rows[0];
  }

  async keyTaken(tx: DbTransaction, target: CustomFieldTarget, key: string): Promise<boolean> {
    const rows = await tx
      .select({ id: customFieldDefs.id })
      .from(customFieldDefs)
      .where(and(eq(customFieldDefs.target, target), eq(customFieldDefs.key, key)))
      .limit(1);

    return rows.length > 0;
  }

  async nextSortOrder(tx: DbTransaction, target: CustomFieldTarget): Promise<number> {
    const rows = await tx
      .select({ next: sql<number>`coalesce(max(${customFieldDefs.sortOrder}), -1) + 1` })
      .from(customFieldDefs)
      .where(eq(customFieldDefs.target, target));

    return rows[0]?.next ?? 0;
  }

  async create(tx: DbTransaction, values: NewCustomFieldDef): Promise<CustomFieldDefRow> {
    const rows = await tx.insert(customFieldDefs).values(values).returning();

    const row = rows[0];
    /* c8 ignore next 3 -- an insert refused by a policy raises; it never returns nothing. */
    if (row === undefined) {
      throw new Error('The custom field insert returned no row');
    }

    return row;
  }

  async update(
    tx: DbTransaction,
    fieldId: string,
    values: Partial<NewCustomFieldDef>,
  ): Promise<CustomFieldDefRow | undefined> {
    const rows = await tx
      .update(customFieldDefs)
      .set(values)
      .where(eq(customFieldDefs.id, fieldId))
      .returning();

    return rows[0];
  }

  /**
   * Deletes the definition and leaves the stored values alone.
   *
   * Rewriting every ticket, contact and account of the brand to strip one key
   * is a migration, run inside a request, for a change somebody may undo in a
   * minute. Reads filter by the definitions instead (`visibleCustomValues`), so
   * an orphaned key is invisible everywhere and a definition re-created with
   * the same key brings its values back.
   */
  async delete(tx: DbTransaction, fieldId: string): Promise<void> {
    await tx.delete(customFieldDefs).where(eq(customFieldDefs.id, fieldId));
  }

  async reorder(tx: DbTransaction, fieldIds: readonly string[]): Promise<void> {
    for (const [position, fieldId] of fieldIds.entries()) {
      await tx
        .update(customFieldDefs)
        .set({ sortOrder: position })
        .where(eq(customFieldDefs.id, fieldId));
    }
  }

  // ------------------------------------------------------------------ values

  /**
   * How many rows carry a value for this definition, and how many carry each of
   * its options.
   *
   * `jsonb_exists(custom, key)` rather than the `?` operator it is the function
   * form of: `?` is also the placeholder several drivers use, and a query that
   * reads correctly in every layer is worth one extra word.
   */
  async usage(tx: DbTransaction, def: CustomFieldDefRow): Promise<FieldUsage> {
    const { table, column } = VALUE_COLUMN[def.target];

    const rows = await countOf(tx, table, sql`jsonb_exists(${column}, ${def.key})`);

    // Keyed by an *option*, which is any non-empty string a brand typed — so
    // the object is built from entries rather than by assignment, and a choice
    // somebody named `__proto__` is a count rather than a prototype.
    const counted: [string, number][] = [];
    for (const option of def.options) {
      const count = await countOf(tx, table, optionPredicate(def, column, option));
      if (count > 0) {
        counted.push([option, count]);
      }
    }

    return { rows, optionRows: Object.fromEntries(counted) };
  }

  /**
   * Takes one option off every row that carries it.
   *
   * A `select` loses the whole key, because "one of these three" with the
   * chosen one gone has no answer left. A `multi_select` keeps its other
   * choices and loses only that element — and then loses the key too if that
   * was the last one, so "unset" keeps to one representation
   * (`mergeCustomValues` says why two would be worse).
   *
   * The update is bound by the same policies as every other statement here, so
   * it reaches exactly the rows the actor could have written by hand.
   */
  async clearOption(tx: DbTransaction, def: CustomFieldDefRow, option: string): Promise<void> {
    const { table, column } = VALUE_COLUMN[def.target];

    if (def.type === 'select') {
      await tx.execute(
        sql`UPDATE ${table} SET ${CUSTOM} = ${column} - ${def.key}
            WHERE ${optionPredicate(def, column, option)}`,
      );
      return;
    }

    await tx.execute(
      sql`UPDATE ${table} SET ${CUSTOM} = jsonb_set(${column}, array[${def.key}], (
            SELECT coalesce(jsonb_agg(element), '[]'::jsonb)
            FROM jsonb_array_elements(${column} -> ${def.key}) AS element
            WHERE element <> to_jsonb(${option}::text)
          ))
          WHERE ${optionPredicate(def, column, option)}`,
    );

    await tx.execute(
      sql`UPDATE ${table} SET ${CUSTOM} = ${column} - ${def.key}
          WHERE ${column} -> ${def.key} = '[]'::jsonb`,
    );
  }
}

/**
 * The column being assigned to, unqualified: a `SET` clause names a column and
 * not `"table"."column"`, which is what interpolating the Drizzle column would
 * write. All three targets call it `custom`, which is why one identifier serves.
 */
const CUSTOM = sql.identifier('custom');

/** Which rows carry this option, for the two choice types. */
const optionPredicate = (
  def: Pick<CustomFieldDefRow, 'key' | 'type'>,
  column: PgColumn,
  option: string,
): SQL =>
  def.type === 'select'
    ? sql`${column} ->> ${def.key} = ${option}`
    : sql`jsonb_exists(${column} -> ${def.key}, ${option})`;
