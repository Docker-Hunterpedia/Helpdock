import {
  type AuditLogEntry,
  auditLog,
  brands,
  type DbTransaction,
  isUuid,
  users,
} from '@helpdock/db';
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import type { AuditCursor } from './audit-cursor.js';

/**
 * Every statement the audit log viewer makes (M3-08).
 *
 * `audit_log` is a tenant table and none of these filters by brand for access:
 * the install-scope transaction, widened to every brand by the service, is what
 * decides which rows exist here. The Brand *filter* is a filter like any other.
 * `brands` and `users` are global tables, read for names only.
 */

export interface AuditLogFilter {
  /** A staff member's name or email, or an actor id, matched loosely. */
  readonly actor?: string | undefined;
  /** An exact action, or a family ending in `.*`. */
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly brandId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  /** Rows strictly older than this one. */
  readonly before?: AuditCursor | undefined;
  readonly limit: number;
}

/** `%` and `_` typed into a filter are characters, not wildcards. */
const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (character) => `\\${character}`);

export class AuditLogRepository {
  async list(tx: DbTransaction, filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    const conditions: (SQL | undefined)[] = [
      filter.actor === undefined ? undefined : actorMatches(filter.actor),
      filter.action === undefined ? undefined : actionMatches(filter.action),
      filter.targetType === undefined ? undefined : eq(auditLog.targetType, filter.targetType),
      filter.brandId === undefined ? undefined : eq(auditLog.brandId, filter.brandId),
      filter.from === undefined ? undefined : gte(auditLog.createdAt, filter.from),
      filter.to === undefined ? undefined : lte(auditLog.createdAt, filter.to),
      filter.before === undefined
        ? undefined
        : sql`(${auditLog.createdAt}, ${auditLog.id}) < (${filter.before.at}::timestamptz, ${filter.before.id}::uuid)`,
    ];

    return tx
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(filter.limit);
  }

  async brands(tx: DbTransaction): Promise<{ id: string; name: string }[]> {
    return tx
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .orderBy(asc(brands.name), asc(brands.id));
  }

  /** Names for the staff actors on a page, by id. Ids that are not uuids are jobs and keys. */
  async staffNames(
    tx: DbTransaction,
    actorIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(actorIds.filter(isUuid))];
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));

    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

const actorMatches = (actor: string): SQL => {
  const pattern = `%${escapeLike(actor)}%`;

  return sql`(${auditLog.actorId} ILIKE ${pattern} OR ${auditLog.actorId} IN (
    SELECT ${users.id}::text FROM ${users} WHERE ${users.name} ILIKE ${pattern} OR ${users.email} ILIKE ${pattern}
  ))`;
};

const actionMatches = (action: string): SQL =>
  action.endsWith('.*')
    ? sql`${auditLog.action} LIKE ${`${escapeLike(action.slice(0, -1))}%`}`
    : sql`${auditLog.action} = ${action}`;
