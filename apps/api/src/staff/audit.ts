import { auditLog, type DbTransaction } from '@helpdock/db';

/**
 * Who did what to whom, for every action in DOMAIN-RULES §12.
 *
 * The row is written inside the request's own transaction, so a handler that
 * throws after it rolls the row back with the change it was about: an audit
 * trail that records things that did not happen is worse than none.
 *
 * `meta` carries what the action changed — the role before and after, the
 * departments, the address an invitation went to — and never a credential. The
 * token an invite email carries is a working way into an account, and an audit
 * row is read by more people than a password store is.
 */

export type StaffAuditAction =
  | 'staff.invited'
  | 'staff.invite.resent'
  | 'staff.invite.revoked'
  | 'staff.invite.accepted'
  | 'staff.role.changed'
  | 'staff.deactivated'
  | 'staff.reactivated'
  | 'staff.removed'
  | 'staff.deleted'
  | 'staff.profile.updated'
  | 'staff.password.changed'
  | 'staff.totp.disabled'
  | 'staff.recovery-codes.regenerated'
  | 'staff.session.revoked';

export interface StaffAuditEntry {
  readonly brandId: string;
  readonly actorId: string;
  /** `system` for the invite acceptance, which happens before a principal exists. */
  readonly actorType?: 'staff' | 'system';
  readonly action: StaffAuditAction;
  readonly targetId: string;
  readonly meta?: Record<string, unknown>;
}

export const writeStaffAudit = async (
  tx: DbTransaction,
  { brandId, actorId, actorType = 'staff', action, targetId, meta = {} }: StaffAuditEntry,
): Promise<void> => {
  await tx.insert(auditLog).values({
    brandId,
    actorType,
    actorId,
    action,
    targetType: 'user',
    targetId,
    meta,
  });
};
