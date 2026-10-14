import {
  importActivitySchema,
  importCsatSchema,
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
    csat: z.array(importCsatSchema).max(10000).default([]),
    activities: z.array(importActivitySchema).max(100000).default([]),
    authors: z.record(z.string().max(200), authorSchema),
    resolved: z.strictObject({
      statusId: z.uuid(),
      departmentId: z.uuid(),
      teamId: z.uuid().nullable(),
      priority: ticketPrioritySchema,
      channel: ticketChannelSchema,
      assigneeId: z.uuid().nullable(),
      contactId: z.uuid().nullable(),
      tags: z
        .array(z.strictObject({ externalValue: z.string().max(200), tagId: z.uuid().nullable() }))
        .max(1000)
        .default([]),
      custom: z.record(z.string(), z.json()),
    }),
  })
  .refine(
    (input) =>
      input.messages.every((message) => message.ticketExternalId === input.record.externalId) &&
      input.csat.every((rating) => rating.ticketExternalId === input.record.externalId) &&
      input.activities.every((activity) => activity.ticketExternalId === input.record.externalId),
    { path: ['messages'], message: 'A thread or rating belongs to another source ticket' },
  );
export const mappedTicketLoadSchema = ticketLoadSchema
  .refine(
    (input) =>
      new Set(input.resolved.tags.map((mapping) => mapping.externalValue)).size ===
        input.resolved.tags.length &&
      new Set(input.csat.map((rating) => rating.externalId)).size === input.csat.length &&
      new Set(input.activities.map((activity) => activity.externalId)).size ===
        input.activities.length,
    { message: 'Duplicate tag mappings or source rating IDs' },
  )
  .refine(
    (input) =>
      input.record.tags.every((tag) =>
        input.resolved.tags.some((mapping) => mapping.externalValue === tag),
      ),
    { path: ['resolved', 'tags'], message: 'Every source tag needs a target or explicit skip' },
  );
export type TicketLoad = z.infer<typeof ticketLoadSchema>;

export class ImportLoadError extends Error {
  constructor(
    readonly code:
      | 'identity-ambiguous'
      | 'mapping-invalid'
      | 'author-unmapped'
      | 'target-unavailable'
      | 'duplicate-source-message'
      | 'thread-too-large',
  ) {
    super(code);
    this.name = 'ImportLoadError';
  }
}
