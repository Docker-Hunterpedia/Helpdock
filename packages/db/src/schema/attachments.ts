import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid.js';
import { brands } from './brands.js';
import { departments } from './departments.js';
import {
  attachmentKindEnum,
  attachmentRejectReasonEnum,
  attachmentScanStatusEnum,
  attachmentStatusEnum,
  attachmentUploaderTypeEnum,
} from './enums.js';
import { ticketMessages } from './ticket-messages.js';
import { tickets } from './tickets.js';

/**
 * One uploaded object and what the media pipeline made of it (ARCHITECTURE §9,
 * REQUIREMENTS §4.6).
 *
 * **Department-scoped**, like every other child of a ticket: `department_id` is
 * denormalised from the parent and kept true by the shared
 * `helpdock_ticket_child_department` trigger, so the policy never joins back to
 * `tickets` (DOMAIN-RULES §1.3 layer 3). That is also what makes DOMAIN-RULES
 * §4.5 — "presigned GET URLs are issued only by an endpoint that first
 * authorises the caller on the parent ticket" — a property of the database
 * rather than of a check somebody remembered to write: an attachment on another
 * department's ticket is not visible, so no URL can be issued for it.
 *
 * `message_id` is null until the message is sent. The composer uploads while
 * the agent is still typing, so an attachment exists before the row it belongs
 * to does; `linkAttachmentsToMessage` fills it in inside the same transaction
 * as the message insert.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Overwritten by the trigger with the ticket's own. See the note above. */
    departmentId: uuid('department_id')
      .notNull()
      .references(() => departments.id, { onDelete: 'restrict' }),
    /**
     * `cascade`: DOMAIN-RULES §11 deletes a ticket's attachments with the
     * ticket, and an attachment whose message has gone is an orphan nothing can
     * render. The S3 objects are removed by the same retention pass; the row
     * going first would lose the keys it needs to remove them, so the purge
     * reads the keys before it deletes.
     */
    messageId: uuid('message_id').references(() => ticketMessages.id, { onDelete: 'cascade' }),
    uploaderType: attachmentUploaderTypeEnum('uploader_type').notNull(),
    /**
     * Text and no foreign key, for the same reason as `ticket_messages.author_id`:
     * it names a user, a contact or a job depending on `uploader_type`.
     */
    uploaderId: text('uploader_id').notNull(),
    /**
     * The object the client PUT to. Unique across the install, which is what
     * stops two rows claiming the same bytes; it is built from uuids alone, so
     * nothing a caller typed reaches the bucket's namespace.
     */
    s3Key: text('s3_key').notNull().unique(),
    /** As uploaded, with any path removed (`safeFileName` in @helpdock/schemas). */
    originalName: text('original_name').notNull(),
    /**
     * What the bytes turned out to be. Written from the *declared* type at
     * presign and rewritten by the worker from the magic bytes, so a row that
     * reached `ready` carries what was sniffed and not what was claimed.
     */
    mime: text('mime').notNull(),
    /** `bigint` because a 50 MB cap is a brand setting and caps get raised. */
    size: bigint('size', { mode: 'number' }).notNull(),
    kind: attachmentKindEnum('kind').notNull(),
    status: attachmentStatusEnum('status').notNull().default('pending'),
    /** A key, never a tool's stderr: it is returned to the client and logged. */
    rejectReason: attachmentRejectReasonEnum('reject_reason'),
    /**
     * The derived objects, keyed by variant name. Jsonb rather than a child
     * table because it is read whole, written once and never queried across
     * rows (ARCHITECTURE §9).
     */
    variants: jsonb('variants')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    scanStatus: attachmentScanStatusEnum('scan_status').notNull().default('skipped'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the worker finished, either way. Null while pending or processing. */
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    // The thread's read: every attachment of a message, in one index scan.
    index('attachments_message_idx').on(table.messageId),
    // The composer's read, and the retention pass's: a ticket's attachments,
    // including the ones no message claimed.
    index('attachments_ticket_idx').on(table.ticketId),
    index('attachments_brand_department_idx').on(table.brandId, table.departmentId),
  ],
);

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
