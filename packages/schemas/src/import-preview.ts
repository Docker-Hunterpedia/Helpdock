import { z } from 'zod';
import { importContactSchema, importMessageSchema, importTicketSchema } from './import.js';
import { importAttachmentAvailabilitySchema } from './import-media.js';

const previewExternalIdSchema = importTicketSchema.shape.externalId.refine(
  (id) => !id.includes('\u0000'),
);

export const importTicketPreviewRequestSchema = z.strictObject({
  brandId: z.uuid(),
  runId: z.uuid(),
  externalId: previewExternalIdSchema,
  offset: z.int().nonnegative().max(100000).default(0),
  limit: z.int().min(1).max(50).default(20),
});
export const importTicketPreviewQuerySchema = z.strictObject({
  externalId: importTicketPreviewRequestSchema.shape.externalId,
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ImportTicketPreviewQuery = z.infer<typeof importTicketPreviewQuerySchema>;
const { sourceUrl: _sourceUrl, ...ticketPreviewShape } = importTicketSchema.shape;
export const importTicketPreviewSchema = z.strictObject({
  ticket: z
    .strictObject(ticketPreviewShape)
    .refine((ticket) => importTicketSchema.safeParse(ticket).success),
  messageCount: z.int().nonnegative(),
  nextOffset: z.int().nonnegative().nullable(),
  messages: z
    .array(
      z.strictObject({
        externalId: z.string().min(1).max(200),
        authorKind: importMessageSchema.shape.authorKind,
        authorExternalId: z.string().min(1).max(200).nullable(),
        sourceAuthorName: z.string().min(1).max(200).nullable(),
        public: z.boolean(),
        createdAt: z.iso.datetime({ offset: true }),
        bodyHtml: z.string(),
        bodyText: z.string(),
        attachments: z
          .array(
            z.strictObject({
              externalId: z.string().min(1).max(200),
              fileName: z.string().min(1).max(255),
              contentType: z.string().max(255).optional(),
              size: z.int().nonnegative().optional(),
              availability: importAttachmentAvailabilitySchema.optional(),
            }),
          )
          .max(1000),
      }),
    )
    .max(50),
});

export const importContactPreviewQuerySchema = z.strictObject({
  externalId: previewExternalIdSchema,
  defaultCallingCode: z
    .string()
    .regex(/^\d{0,4}$/)
    .default(''),
});
export type ImportContactPreviewQuery = z.infer<typeof importContactPreviewQuerySchema>;
export const importContactPreviewRequestSchema = importContactPreviewQuerySchema.extend({
  brandId: z.uuid(),
  runId: z.uuid(),
});
export const importContactPreviewSchema = z.strictObject({
  source: importContactSchema,
  plan: z.strictObject({
    action: z.enum(['create', 'link', 'update', 'unchanged']),
    contactId: z.uuid().nullable(),
    accountId: z.uuid().nullable(),
    sourceAccountId: z.uuid().nullable(),
    name: z.string().min(1).max(200),
    sourceName: z.string().min(1).max(200),
    identifiers: z
      .array(
        z.strictObject({ kind: z.enum(['email', 'phone']), value: z.string().min(1).max(320) }),
      )
      .max(200),
    refusedPhones: z.int().nonnegative(),
    organization: z
      .strictObject({
        externalId: z.string().min(1).max(200),
        action: z.enum(['create', 'link', 'update', 'unchanged', 'reuse']),
        accountId: z.uuid().nullable(),
        name: z.string().min(1).max(200),
        sourceName: z.string().min(1).max(200).optional(),
        domains: z.array(z.string().max(253)).max(100).optional(),
      })
      .nullable(),
  }),
});
export const importPreviewSamplesSchema = z.strictObject({
  tickets: z.array(z.string().min(1).max(200)).max(3),
  contacts: z.array(z.string().min(1).max(200)).max(3),
});
