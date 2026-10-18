import { importUrlSchema } from '@helpdock/schemas';
import { z } from 'zod';

/** Desk API request/response reference checked 2026-10-17; never coerce native IDs to numbers. */
export const zohoIdSchema = z.string().regex(/^[1-9]\d{0,199}$/);
const instant = z.iso.datetime({ offset: true });
const nullableId = zohoIdSchema.nullable().optional();
const nullableText = z.string().nullable().optional();
// The official ticket-detail example uses "false" while contact detail uses false.
const flag = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

export const zohoTicketIndexSchema = z.object({
  id: zohoIdSchema,
  createdTime: instant,
  modifiedTime: instant,
});
export const zohoTicketSchema = zohoTicketIndexSchema.extend({
  ticketNumber: z.string().min(1).max(50),
  subject: z.string().nullable(),
  status: z.string().min(1).max(300),
  statusType: z.string().min(1).max(100),
  priority: nullableText,
  channel: z.string().min(1).max(300),
  contactId: zohoIdSchema,
  departmentId: zohoIdSchema,
  assigneeId: nullableId,
  accountId: nullableId,
  teamId: nullableId,
  contact: z
    .object({
      id: zohoIdSchema,
      email: nullableText,
      account: z.object({ id: zohoIdSchema }).nullable().optional(),
    })
    .nullable()
    .optional(),
  description: z
    .string()
    .max(2 * 1024 * 1024)
    .nullable()
    .optional(),
  resolution: nullableText,
  closedTime: instant.nullable().optional(),
  webUrl: importUrlSchema.optional(),
  cf: z.record(z.string(), z.json()).default({}),
  secondaryContacts: z.array(zohoIdSchema).max(100).default([]),
  isTrashed: flag.optional(),
  isDeleted: flag.optional(),
  isSpam: flag.optional(),
  isArchived: flag.optional(),
});

export const zohoTicketTagsSchema = z.object({
  tags: z.array(z.object({ name: z.string().min(1).max(200) })).max(1000),
});
export const zohoHistoryTicketSchema = zohoTicketSchema.pick({
  id: true,
  departmentId: true,
  isArchived: true,
  contactId: true,
  contact: true,
  description: true,
  createdTime: true,
  isDeleted: true,
  isTrashed: true,
  isSpam: true,
});

export const zohoAttachmentSchema = z.object({
  id: zohoIdSchema,
  name: z.string().min(1).max(255),
  size: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => Number.isSafeInteger(Number(value))),
  href: importUrlSchema,
});
export const zohoTicketAttachmentSchema = zohoAttachmentSchema.extend({
  createdTime: instant,
  isPublic: z.boolean(),
  creatorId: zohoIdSchema.nullable().optional(),
  creator: z
    .object({
      id: zohoIdSchema,
      firstName: nullableText,
      lastName: nullableText,
      email: nullableText,
    })
    .nullable()
    .optional(),
});
export const zohoThreadIndexSchema = z.object({
  id: zohoIdSchema,
  createdTime: instant,
  visibility: z.string(),
  direction: z.string(),
  isDescriptionThread: z.boolean(),
  status: z.string(),
});
const authorSchema = z.object({
  id: nullableId,
  name: nullableText,
  firstName: nullableText,
  lastName: nullableText,
  type: z.string(),
  email: nullableText,
});
export const zohoThreadSchema = zohoThreadIndexSchema.extend({
  content: z.string(),
  plainText: nullableText,
  contentType: z.string(),
  isContentTruncated: z.boolean(),
  fullContentURL: importUrlSchema.nullable().optional(),
  author: authorSchema.nullable(),
  responderId: nullableId,
  fromEmailAddress: nullableText,
  to: nullableText,
  cc: nullableText,
  attachments: z.array(zohoAttachmentSchema).max(1000),
  channel: z.string(),
});
export const zohoCommentSchema = z.object({
  id: zohoIdSchema,
  commentedTime: instant,
  modifiedTime: instant.nullable(),
  isPublic: z.boolean(),
  content: z.string(),
  plainText: nullableText,
  contentType: z.string(),
  commenterId: nullableId,
  commenter: authorSchema.nullable(),
  attachments: z.array(zohoAttachmentSchema).max(1000),
});
