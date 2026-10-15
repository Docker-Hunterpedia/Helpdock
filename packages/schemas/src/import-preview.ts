import { z } from 'zod';
import { importMessageSchema, importTicketSchema } from './import.js';

export const importTicketPreviewRequestSchema = z.strictObject({
  brandId: z.uuid(),
  runId: z.uuid(),
  externalId: z.string().min(1).max(200),
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
            }),
          )
          .max(1000),
      }),
    )
    .max(50),
});
