import { auditLog, type DbTransaction, users } from '@helpdock/db';
import {
  HC_ACTIVITY_LIMIT,
  type HcActivityAction,
  type HcActivityEntry,
  hcActivityActionSchema,
  localeSchema,
} from '@helpdock/schemas';
import { and, desc, eq, sql } from 'drizzle-orm';

/**
 * Who changed the brand's help center, and what (M5-01, M5-02, M5-09).
 *
 * Every change is an `audit_log` row written in the transaction of the change,
 * as `ticketing/audit.ts` does for the brand's ticketing vocabulary. The
 * editor's Activity panel is those rows for one article (`readActivity`), so
 * "who published this and when" has one source, and the audit log viewer
 * shows the same rows with the rest.
 *
 * Autosave is not a row per keystroke: an edit is recorded once per person,
 * language and {@link EDIT_WINDOW_MS}, which is what "Edited · Omar Aziz ·
 * 11 Sep 18:20" means to a reader.
 */

export type HcAuditAction =
  | `hc_article.${HcActivityAction}`
  | 'hc_article.deleted'
  | 'hc_category.created'
  | 'hc_category.updated'
  | 'hc_category.deleted'
  | 'hc_section.created'
  | 'hc_section.updated'
  | 'hc_section.deleted'
  | 'hc_structure.reordered'
  | 'hc_settings.updated';

export type HcAuditTarget = 'hc_article' | 'hc_category' | 'hc_section' | 'hc_settings';

/** A person, or the scheduled publish job acting on nobody's behalf. */
export interface HcActor {
  readonly type: 'staff' | 'system';
  readonly id: string;
}

export interface HcAuditEntry {
  readonly brandId: string;
  readonly actor: HcActor;
  readonly action: HcAuditAction;
  readonly targetType: HcAuditTarget;
  readonly targetId: string;
  readonly meta?: Record<string, unknown>;
}

/** One "Edited" per person and language in this window, however often autosave runs. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const writeHcAudit = async (
  tx: DbTransaction,
  { brandId, actor, action, targetType, targetId, meta = {} }: HcAuditEntry,
): Promise<void> => {
  await tx.insert(auditLog).values({
    brandId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType,
    targetId,
    meta,
  });
};

/** Whether this person already has an edit of this language on record inside the window. */
export const editedRecently = async (
  tx: DbTransaction,
  {
    articleId,
    locale,
    actorId,
    now,
  }: {
    readonly articleId: string;
    readonly locale: string;
    readonly actorId: string;
    readonly now: Date;
  },
): Promise<boolean> => {
  const since = new Date(now.getTime() - EDIT_WINDOW_MS);
  const rows = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, 'hc_article'),
        eq(auditLog.targetId, articleId),
        eq(auditLog.actorId, actorId),
        sql`${auditLog.action} in ('hc_article.edited', 'hc_article.created')`,
        sql`${auditLog.meta}->>'locale' = ${locale}`,
        sql`${auditLog.createdAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);

  return rows.length > 0;
};

const PREFIX = 'hc_article.';

/**
 * The newest entries of one article's Activity panel. The actor's name is
 * joined from `users` by id; a system actor has none, and a row whose action
 * this version of the panel does not name is skipped rather than shown raw.
 */
export const readActivity = async (
  tx: DbTransaction,
  articleId: string,
  limit = HC_ACTIVITY_LIMIT,
): Promise<HcActivityEntry[]> => {
  const rows = await tx
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorType: auditLog.actorType,
      meta: auditLog.meta,
      createdAt: auditLog.createdAt,
      actorName: users.name,
    })
    .from(auditLog)
    .leftJoin(users, sql`${users.id}::text = ${auditLog.actorId}`)
    .where(and(eq(auditLog.targetType, 'hc_article'), eq(auditLog.targetId, articleId)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);

  return rows.flatMap((row) => {
    const action = hcActivityActionSchema.safeParse(row.action.slice(PREFIX.length));
    if (!row.action.startsWith(PREFIX) || !action.success) {
      return [];
    }
    const locale = localeSchema.safeParse(row.meta.locale);
    const detail = row.meta.scheduledAt ?? row.meta.visibility ?? row.meta.slug ?? null;

    return [
      {
        id: row.id,
        action: action.data,
        locale: locale.success ? locale.data : null,
        actorName: row.actorType === 'staff' ? (row.actorName ?? null) : null,
        at: row.createdAt.toISOString(),
        detail: typeof detail === 'string' ? detail : null,
      },
    ];
  });
};
