import { auditLog, type DbTransaction } from '@helpdock/db';

/**
 * Who changed which contact, written inside the request's own transaction so a
 * handler that throws afterwards rolls the row back with the change it was
 * about.
 *
 * `meta` carries what changed — the fields, the kind of identifier, the count
 * of things erased — and **never an identifier's value**. DOMAIN-RULES §11 says
 * an erasure is "recorded in the audit log without the erased values", and an
 * address is no less personal on the row that added it than on the row that
 * removed it.
 */

export type ContactAuditAction =
  | 'contact.created'
  | 'contact.updated'
  | 'contact.identity.added'
  | 'contact.identity.removed'
  | 'contact.note.added'
  | 'contact.duplicate.dismissed'
  | 'contact.anonymised'
  | 'contact.merged'
  | 'contact.merge.undone'
  | 'account.created'
  | 'account.updated';

export interface ContactAuditEntry {
  readonly brandId: string;
  readonly actorId: string;
  readonly action: ContactAuditAction;
  readonly targetType: 'contact' | 'account';
  readonly targetId: string;
  readonly meta?: Record<string, unknown>;
}

export const writeContactAudit = async (
  tx: DbTransaction,
  { brandId, actorId, action, targetType, targetId, meta = {} }: ContactAuditEntry,
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
