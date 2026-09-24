import { auditLog, type DbTransaction } from '@helpdock/db';

/**
 * Who changed a brand's tags, custom fields or templates, and to what.
 *
 * Its own verbs rather than an extension of `brands/audit.ts`, because the two
 * describe different things and the union in each file is what stops a typo
 * becoming a new action nobody can search for. Everything else is the same
 * contract: the row is written inside the request's own transaction, so a
 * handler that throws afterwards rolls the entry back with the change it
 * described.
 *
 * These are **definition** changes — a brand's configuration — so they go to
 * `audit_log`. Putting a tag on a ticket is a change to the ticket and goes to
 * `ticket_activity` instead, which is what the thread renders and what
 * retention purges with the ticket (DOMAIN-RULES §11).
 */

export type TicketingAuditAction =
  | 'tag.created'
  | 'tag.updated'
  | 'tag.deleted'
  | 'tag.reordered'
  | 'custom_field.created'
  | 'custom_field.updated'
  | 'custom_field.deleted'
  | 'custom_field.reordered'
  | 'ticket_template.created'
  | 'ticket_template.updated'
  | 'ticket_template.deleted'
  /** M1-07: a department's assignment settings, and one agent's place in its rotation. */
  | 'assignment.updated'
  | 'assignment.agent.updated';

export type TicketingAuditTarget =
  | 'tag'
  | 'custom_field'
  | 'ticket_template'
  | 'brand'
  | 'department';

export interface TicketingAuditEntry {
  readonly brandId: string;
  readonly actorId: string;
  readonly action: TicketingAuditAction;
  readonly targetType: TicketingAuditTarget;
  readonly targetId: string;
  /** The before and after of what changed. Never a secret; there is none here. */
  readonly meta?: Record<string, unknown>;
}

export const writeTicketingAudit = async (
  tx: DbTransaction,
  { brandId, actorId, action, targetType, targetId, meta = {} }: TicketingAuditEntry,
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
