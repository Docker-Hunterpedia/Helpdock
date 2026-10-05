import { sql } from 'drizzle-orm';
import type { Db, DbTransaction } from './client.js';
import { OWNER_SCOPED_TABLES } from './rls.js';
import { users } from './schema/users.js';
import { systemContext, withTenant } from './tenant.js';

/**
 * Deleting every row a brand owns (M8-07, DOMAIN-RULES §11), for the brand
 * purge job. It lives beside `rls.ts` because it is the same kind of
 * knowledge: what makes a table a tenant table, and how row-level security
 * decides who may touch its rows.
 *
 * **Which tables** is read from the database at purge time, not from a list:
 * every base table with a `brand_id` column. A table added by a later
 * migration is purged without anybody remembering to add it here, and
 * `rls.integration.test.ts` fails if a tenant table keeps a row.
 *
 * **The order** is the foreign keys': a table is emptied before every table it
 * references, so no delete is refused by a child row still pointing at it. A
 * cycle is broken at a key that does not block a delete — one that cascades
 * or sets null, which the database follows itself; a cycle of blocking keys
 * has no safe order, and {@link purgeOrder} says so rather than guessing.
 *
 * **Tenancy.** Every batch runs as the system principal of this brand alone
 * (DOMAIN-RULES §1.4), so row-level security keeps the purge to the brand
 * whatever a statement says. The personal rows of an owner-scoped table (a
 * saved view, a personal canned response) are visible only to their owner
 * ({@link OWNER_SCOPED_TABLES}), so those tables are drained once more in each
 * person's name.
 */

export interface ForeignKey {
  /** The table holding the key. */
  readonly child: string;
  /** The table it points at. */
  readonly parent: string;
  /** Whether a delete of the parent row is refused while the child exists (`NO ACTION`, `RESTRICT`). */
  readonly blocking: boolean;
}

export class UnorderablePurgeError extends Error {
  readonly tables: readonly string[];

  constructor(tables: readonly string[]) {
    super(`No delete order satisfies the foreign keys between ${tables.join(', ')}`);
    this.name = 'UnorderablePurgeError';
    this.tables = tables;
  }
}

/** `tables`, children before parents. Keys to tables outside `tables` are ignored. */
export const purgeOrder = (
  tables: readonly string[],
  keys: readonly ForeignKey[],
): readonly string[] => {
  const included = new Set(tables);
  const edges = keys.filter(
    (key) => key.child !== key.parent && included.has(key.child) && included.has(key.parent),
  );
  const remaining = new Set([...tables].sort());
  const order: string[] = [];

  // A parent may go once no remaining child points at it.
  const ready = (table: string, considered: readonly ForeignKey[]): boolean =>
    !considered.some((key) => key.parent === table && remaining.has(key.child));

  for (let considered = edges; remaining.size > 0; ) {
    const next = [...remaining].filter((table) => ready(table, considered));
    if (next.length > 0) {
      for (const table of next) {
        remaining.delete(table);
        order.push(table);
      }
      considered = edges;
      continue;
    }
    if (considered.some((key) => !key.blocking)) {
      considered = considered.filter((key) => key.blocking);
      continue;
    }
    throw new UnorderablePurgeError([...remaining]);
  }

  return order;
};

/** Every base table with a `brand_id` column. `brands` itself has `id`, not `brand_id`. */
export const brandOwnedTables = async (tx: DbTransaction): Promise<string[]> => {
  const rows = await tx.execute<{ table_name: string }>(sql`
    SELECT c.table_name::text AS table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'brand_id' AND t.table_type = 'BASE TABLE'
    ORDER BY 1`);

  return rows.map((row) => row.table_name);
};

/** The foreign keys between public tables, from the catalog. */
export const foreignKeys = async (tx: DbTransaction): Promise<ForeignKey[]> => {
  const rows = await tx.execute<{ child: string; parent: string; action: string }>(sql`
    SELECT child.relname::text AS child, parent.relname::text AS parent,
      con.confdeltype::text AS action
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`);

  // `a` is NO ACTION and `r` RESTRICT: the two that refuse the delete.
  return rows.map((row) => ({
    child: row.child,
    parent: row.parent,
    blocking: row.action === 'a' || row.action === 'r',
  }));
};

/**
 * One batch of one table. `ctid` rather than a key column, because the tables
 * do not share one — `ticket_tags` has a composite key, `report_daily` none.
 * The table name comes from the catalog and is quoted as an identifier.
 */
const deleteBatch = async (
  tx: DbTransaction,
  table: string,
  brandId: string,
  limit: number,
): Promise<number> => {
  const deleted = await tx.execute(sql`
    DELETE FROM ${sql.identifier(table)}
    WHERE ctid = ANY (ARRAY(
      SELECT ctid FROM ${sql.identifier(table)} WHERE brand_id = ${brandId} LIMIT ${limit}
    ))`);

  return deleted.count;
};

const drain = async (batch: () => Promise<number>, limit: number): Promise<number> => {
  let total = 0;
  for (;;) {
    const removed = await batch();
    total += removed;
    if (removed < limit) {
      return total;
    }
  }
};

export interface PurgeBrandRowsOptions {
  readonly db: Db;
  readonly brandId: string;
  /** The system principal id every transaction is recorded under: the purge job's id. */
  readonly principalId: string;
  readonly batchSize?: number;
}

/** Deletes every row the brand owns and answers how many, by table. */
export const purgeBrandRows = async ({
  db,
  brandId,
  principalId,
  batchSize = 1_000,
}: PurgeBrandRowsOptions): Promise<Record<string, number>> => {
  const asSystem = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withTenant(db, systemContext(brandId, principalId), fn);
  const plan = await asSystem(async (tx) =>
    purgeOrder(await brandOwnedTables(tx), await foreignKeys(tx)),
  );
  const personal = new Set(
    OWNER_SCOPED_TABLES.filter((table) => table.systemWrites !== true).map((table) => table.name),
  );
  const people = await db.select({ id: users.id }).from(users);
  const counts: Record<string, number> = {};

  for (const table of plan) {
    const batch = (tx: DbTransaction) => deleteBatch(tx, table, brandId, batchSize);
    let removed = await drain(() => asSystem(batch), batchSize);
    if (personal.has(table)) {
      for (const person of people) {
        removed += await drain(
          () => withTenant(db, { ...systemContext(brandId), principalId: person.id }, batch),
          batchSize,
        );
      }
    }
    counts[table] = removed;
  }

  return counts;
};
