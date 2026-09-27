import { z } from 'zod';
import { brandIdParamSchema, localeSchema } from './brand.js';
import { SMTP_RESPONSE_MAX_LENGTH, smtpErrorCodeSchema, smtpTlsModeSchema } from './install.js';
import { ticketParamSchema } from './ticket.js';

/**
 * Outbound email (M2-05) and auto-replies (M2-06): the Outgoing email tab of
 * Channels (artboard `AdminEmailOutgoing`), the Email signature tab of Your
 * account (`AdminSignature`), and the composer's email mode and the "Not
 * delivered" state in the ticket view (`AdminTicketEmail`).
 */

const MAX_ADDRESS = 320;
const MAX_HOST = 253;

/** An address and the name shown beside it: `Helpdock Billing <billing@helpdock.io>`. */
export const emailSenderSchema = z.object({
  name: z.string().trim().max(120),
  address: z.email().max(MAX_ADDRESS),
});
export type EmailSender = z.infer<typeof emailSenderSchema>;

// --------------------------------------------------------------------------
// SMTP
// --------------------------------------------------------------------------

/**
 * The brand's server as the form shows it. The password is never returned
 * (AGENTS.md, secrets): `passwordSet` says whether one is stored.
 */
export const outgoingSmtpSchema = z.object({
  host: z.string().min(1).max(MAX_HOST),
  port: z.int().min(1).max(65_535),
  tls: smtpTlsModeSchema,
  user: z.string().max(MAX_ADDRESS),
  passwordSet: z.boolean(),
  updatedAt: z.iso.datetime().nullable(),
  updatedByName: z.string().nullable(),
});
export type OutgoingSmtp = z.infer<typeof outgoingSmtpSchema>;

/**
 * A save or a test. `password` left out keeps the stored one, which is how the
 * form's "Replace" button works: the field is read-only until it is pressed.
 */
export const outgoingSmtpUpdateSchema = z.object({
  host: z.string().trim().min(1).max(MAX_HOST),
  port: z.int().min(1).max(65_535),
  tls: smtpTlsModeSchema,
  user: z.string().trim().max(MAX_ADDRESS),
  password: z.string().max(512).optional(),
});
export type OutgoingSmtpUpdate = z.infer<typeof outgoingSmtpUpdateSchema>;

/**
 * The outcome of "Test SMTP": one message to the person who pressed it. Unlike
 * the first-run wizard's, the relay's own words may be shown (`detail`): only a
 * signed-in Admin reads this, about their own server.
 */
export const outgoingSmtpTestResultSchema = z.object({
  delivered: z.boolean(),
  recipient: z.email(),
  durationMs: z.int().nonnegative(),
  response: z.string().max(SMTP_RESPONSE_MAX_LENGTH).optional(),
  error: smtpErrorCodeSchema.optional(),
  detail: z.string().max(SMTP_RESPONSE_MAX_LENGTH).optional(),
});
export type OutgoingSmtpTestResult = z.infer<typeof outgoingSmtpTestResultSchema>;

// --------------------------------------------------------------------------
// Senders
// --------------------------------------------------------------------------

export const departmentSenderSchema = z.object({
  departmentId: z.uuid(),
  from: emailSenderSchema,
  replyTo: z.email().max(MAX_ADDRESS).nullable(),
});
export type DepartmentSender = z.infer<typeof departmentSenderSchema>;

/** "From and Reply-To per department", with the default for every other one. */
export const emailSendersSchema = z
  .object({
    defaultFrom: emailSenderSchema.nullable(),
    departments: z.array(departmentSenderSchema).max(200),
  })
  .refine(
    ({ departments }) =>
      new Set(departments.map((row) => row.departmentId)).size === departments.length,
    { message: 'A department can have one sender.', path: ['departments'] },
  );
export type EmailSenders = z.infer<typeof emailSendersSchema>;

// --------------------------------------------------------------------------
// Auto-replies (M2-06)
// --------------------------------------------------------------------------

export const AUTO_REPLY_KINDS = ['acknowledgment', 'outOfHours'] as const;
export const autoReplyKindSchema = z.enum(AUTO_REPLY_KINDS);
export type AutoReplyKind = z.infer<typeof autoReplyKindSchema>;

/** The placeholders a template may use, as the editor lists them. */
export const AUTO_REPLY_PLACEHOLDERS = [
  '{{ticket.number}}',
  '{{contact.first_name}}',
  '{{department.name}}',
  '{{brand.name}}',
] as const;

export const autoReplyTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  /** Plain text. Blank lines separate paragraphs; the layout adds the rest. */
  body: z.string().trim().min(1).max(4_000),
});
export type AutoReplyTemplate = z.infer<typeof autoReplyTemplateSchema>;

export const autoReplyTemplatesSchema = z.object({
  en: autoReplyTemplateSchema,
  ar: autoReplyTemplateSchema,
});
export type AutoReplyTemplates = z.infer<typeof autoReplyTemplatesSchema>;

export const AUTO_REPLY_CAP_MIN = 1;
export const AUTO_REPLY_CAP_MAX = 50;

export const autoRepliesSchema = z.object({
  acknowledgment: z.object({ enabled: z.boolean(), templates: autoReplyTemplatesSchema }),
  outOfHours: z.object({ enabled: z.boolean(), templates: autoReplyTemplatesSchema }),
  /** Loop protection: auto-replies to one sender per rolling hour. */
  perSenderHourlyCap: z.int().min(AUTO_REPLY_CAP_MIN).max(AUTO_REPLY_CAP_MAX),
});
export type AutoReplies = z.infer<typeof autoRepliesSchema>;

// --------------------------------------------------------------------------
// The tab
// --------------------------------------------------------------------------

export const emailOutgoingSettingsSchema = z.object({
  /** Null when the brand has no server of its own and sends through the install's. */
  smtp: outgoingSmtpSchema.nullable(),
  /** Whether the install's own server (set by the first-run wizard) is there to fall back on. */
  installSmtpConfigured: z.boolean(),
  senders: emailSendersSchema,
  autoReplies: autoRepliesSchema,
});
export type EmailOutgoingSettings = z.infer<typeof emailOutgoingSettingsSchema>;

// --------------------------------------------------------------------------
// Deliveries and the dead-letter queue
// --------------------------------------------------------------------------

export const EMAIL_DELIVERY_STATUSES = ['queued', 'sent', 'failed', 'discarded'] as const;
export const emailDeliveryStatusSchema = z.enum(EMAIL_DELIVERY_STATUSES);
export type EmailDeliveryStatus = z.infer<typeof emailDeliveryStatusSchema>;

/** Attempts per round before a send lands in Failed sends. Also the `email.send` job's. */
export const EMAIL_SEND_ATTEMPTS = 5;

/** How much of a relay's refusal is kept and shown. */
export const EMAIL_ERROR_MAX_LENGTH = 300;

/** One row of Failed sends. */
export const failedSendSchema = z.object({
  id: z.uuid(),
  recipient: z.string().max(MAX_ADDRESS),
  ticketId: z.uuid(),
  /** `HD-1042`. */
  ticketReference: z.string(),
  lastError: z.string().max(EMAIL_ERROR_MAX_LENGTH).nullable(),
  attempts: z.int().nonnegative(),
  maxAttempts: z.int().positive(),
  failedAt: z.iso.datetime(),
});
export type FailedSend = z.infer<typeof failedSendSchema>;

export const failedSendListSchema = z.object({ items: z.array(failedSendSchema) });
export type FailedSendList = z.infer<typeof failedSendListSchema>;

export const failedSendParamSchema = brandIdParamSchema.extend({ deliveryId: z.uuid() });
export type FailedSendParam = z.infer<typeof failedSendParamSchema>;

/** How many sends a "Retry all" put back in the queue. */
export const failedSendRetryResultSchema = z.object({ retried: z.int().nonnegative() });
export type FailedSendRetryResult = z.infer<typeof failedSendRetryResultSchema>;

/** What the thread draws under an outbound reply. */
export const messageDeliverySchema = z.object({
  messageId: z.uuid(),
  status: emailDeliveryStatusSchema,
  attempts: z.int().nonnegative(),
  lastError: z.string().max(EMAIL_ERROR_MAX_LENGTH).nullable(),
});
export type MessageDelivery = z.infer<typeof messageDeliverySchema>;

// --------------------------------------------------------------------------
// Signatures
// --------------------------------------------------------------------------

export const EMAIL_SIGNATURE_MAX_LINES = 6;
export const EMAIL_SIGNATURE_MAX_LENGTH = 600;

const lineCount = (value: string): number => (value === '' ? 0 : value.split(/\r?\n/).length);

const signatureTextSchema = z
  .string()
  .max(EMAIL_SIGNATURE_MAX_LENGTH)
  .transform((value) => value.replace(/\s+$/u, ''))
  .refine((value) => lineCount(value) <= EMAIL_SIGNATURE_MAX_LINES, {
    message: 'too-many-lines',
  });

/** Plain text, up to six lines, in each language. Empty means none. */
export const emailSignatureSchema = z.object({
  en: signatureTextSchema,
  ar: signatureTextSchema,
});
export type EmailSignature = z.infer<typeof emailSignatureSchema>;

// --------------------------------------------------------------------------
// The composer's email mode
// --------------------------------------------------------------------------

/**
 * The channels whose public replies are emailed to the contact and CCs. A
 * chat or Telegram ticket answers on its own channel (M4, M6); an email, web
 * form or agent-created ticket has no other way to reach the customer.
 */
export const EMAIL_REPLY_CHANNELS = ['email', 'form', 'manual'] as const;

export const repliesByEmail = (channel: string): boolean =>
  (EMAIL_REPLY_CHANNELS as readonly string[]).includes(channel);

/** `default` or a department id: which sender a reply goes out as. */
export const emailSenderKeySchema = z.union([z.literal('default'), z.uuid()]);
export type EmailSenderKey = z.infer<typeof emailSenderKeySchema>;

export const ticketEmailContextSchema = z.object({
  /** Every sender the brand has, for the From select. */
  senders: z.array(z.object({ key: emailSenderKeySchema, from: emailSenderSchema })),
  /** The ticket's department's sender, preselected; null when none is configured. */
  selectedKey: emailSenderKeySchema.nullable(),
  /** The contact's address, or null when they have none and nothing can be sent. */
  to: z.object({ name: z.string(), address: z.string().max(MAX_ADDRESS) }).nullable(),
  /** The signature the reply will carry, in the language it will be written in. */
  signature: z.string().max(EMAIL_SIGNATURE_MAX_LENGTH).nullable(),
  locale: localeSchema,
  deliveries: z.array(messageDeliverySchema),
});
export type TicketEmailContext = z.infer<typeof ticketEmailContextSchema>;

export const ticketMessageDeliveryParamSchema = ticketParamSchema.extend({ messageId: z.uuid() });
export type TicketMessageDeliveryParam = z.infer<typeof ticketMessageDeliveryParamSchema>;
