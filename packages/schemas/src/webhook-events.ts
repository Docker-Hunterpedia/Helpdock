import { z } from 'zod';

const ticketRef = z.object({ ticketId: z.uuid(), departmentId: z.uuid() });
const brandRef = z.object({ departmentId: z.null() });

/** Transactional references; message and note bodies never enter the outbox. */
export const webhookSourcePayloadSchemas = {
  'ticket.assigned': ticketRef.extend({
    assigneeId: z.uuid(),
    assignedBy: z.enum(['person', 'rule', 'round_robin', 'skill_based', 'sla']),
    actorId: z.uuid().nullable(),
  }),
  'ticket.status_changed': ticketRef.extend({ previousStatusId: z.uuid(), statusId: z.uuid() }),
  'ticket.merged': ticketRef.extend({ mergedIntoId: z.uuid(), previousDepartmentId: z.uuid() }),
  'message.created': ticketRef.extend({ messageId: z.uuid() }),
  'contact.updated': brandRef.extend({ contactId: z.uuid() }),
  'contact.merged': brandRef.extend({ contactId: z.uuid(), mergedContactId: z.uuid() }),
  'account.created': brandRef.extend({ accountId: z.uuid() }),
  'account.updated': brandRef.extend({ accountId: z.uuid() }),
} as const;
export type AdditionalWebhookEvent = keyof typeof webhookSourcePayloadSchemas;
