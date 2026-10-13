import {
  importMessageSchema,
  importSourceSchema,
  importTicketSchema,
  ticketChannelSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { z } from 'zod';

const authorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('staff'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('contact'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('name'), name: z.string().min(1).max(200) }),
]);
export const ticketLoadSchema = z
  .strictObject({
    brandId: z.uuid(),
    runId: z.uuid(),
    source: importSourceSchema,
    record: importTicketSchema,
    messages: z.array(importMessageSchema).max(100000),
    authors: z.record(z.string().max(200), authorSchema),
    resolved: z.strictObject({
      statusId: z.uuid(),
      departmentId: z.uuid(),
      teamId: z.uuid().nullable(),
      priority: ticketPrioritySchema,
      channel: ticketChannelSchema,
      assigneeId: z.uuid().nullable(),
      contactId: z.uuid().nullable(),
      custom: z.record(z.string(), z.json()),
    }),
  })
  .refine(
    (input) =>
      input.messages.every((message) => message.ticketExternalId === input.record.externalId),
    { path: ['messages'], message: 'A message belongs to another source ticket' },
  );
export type TicketLoad = z.infer<typeof ticketLoadSchema>;

export class ImportLoadError extends Error {
  constructor(
    readonly code:
      | 'identity-ambiguous'
      | 'mapping-invalid'
      | 'author-unmapped'
      | 'target-unavailable'
      | 'duplicate-source-message',
  ) {
    super(code);
    this.name = 'ImportLoadError';
  }
}
