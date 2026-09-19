import { auditLog, type DbTransaction } from '@helpdock/db';

/**
 * Who changed a brand's shape, and to what.
 *
 * The row is written inside the request's own transaction, so a handler that
 * throws after it rolls the row back with the change it was about: an audit
 * trail that records things that did not happen is worse than none.
 *
 * `meta` carries the before and after of what changed — the old name, the team
 * that became the default, the order a list was put in — and never a secret,
 * because there is none in this file's subject matter and there must not be one
 * in the next.
 */

export type BrandAuditAction =
  | 'brand.created'
  | 'brand.updated'
  | 'department.created'
  | 'department.updated'
  | 'department.deleted'
  | 'department.reordered'
  | 'team.created'
  | 'team.updated'
  | 'team.deleted'
  | 'team.member.added'
  | 'team.member.removed';

/** What the row points at, so a reader can tell a team apart from a brand. */
export type BrandAuditTarget = 'brand' | 'department' | 'team' | 'team_member';

export interface BrandAuditEntry {
  readonly brandId: string;
  readonly actorId: string;
  readonly action: BrandAuditAction;
  readonly targetType: BrandAuditTarget;
  readonly targetId: string;
  readonly meta?: Record<string, unknown>;
}

export const writeBrandAudit = async (
  tx: DbTransaction,
  { brandId, actorId, action, targetType, targetId, meta = {} }: BrandAuditEntry,
): Promise<void> => {
  await tx.insert(auditLog).values({
    brandId,
    actorType: 'staff',
    actorId,
    action,
    targetType,
    targetId,
    meta,
  });
};
