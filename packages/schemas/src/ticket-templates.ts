import { z } from 'zod';
import { MAX_TAGS_PER_BRAND } from './tags.js';
import { TICKET_SUBJECT_MAX, ticketPrioritySchema } from './ticket.js';

/**
 * Ticket templates (M1-06): "predefined subject/fields for manual creation"
 * (REQUIREMENTS §4.1).
 *
 * A template is a starting point, never a constraint. `POST /tickets` applies
 * it **server-side** — the browser sends a `templateId`, not a copy of the
 * template — so a template edited between the picker rendering and the ticket
 * being filed is applied as it is now, and an API client gets the same
 * behaviour as the admin without reimplementing it.
 *
 * `bodyText` is plain text in M1. The rich composer is M5's TipTap; until then
 * the api wraps the text into paragraphs and puts it through the same sanitiser
 * as any other message, so nothing stored here is ever rendered unescaped.
 */

export const TEMPLATE_NAME_MAX_LENGTH = 120;
export const TEMPLATE_BODY_MAX = 20_000;
export const MAX_TEMPLATES_PER_BRAND = 200;

/**
 * The placeholders {@link ticketTemplatePreviewSchema} resolves, as an
 * allow-list. It is a fixed list rather than a path into an object on purpose:
 * `{{constructor.constructor}}` and `{{__proto__.x}}` are ordinary-looking
 * paths, and a renderer that walks properties would answer them.
 */
export const TEMPLATE_PLACEHOLDERS = [
  'contact.first_name',
  'contact.last_name',
  'contact.name',
  'contact.email',
  'ticket.number',
  'brand.name',
] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

const templateNameSchema = z.string().trim().min(1).max(TEMPLATE_NAME_MAX_LENGTH);
const templateSubjectSchema = z.string().trim().min(1).max(TICKET_SUBJECT_MAX);
const templateBodySchema = z.string().trim().min(1).max(TEMPLATE_BODY_MAX);

export const ticketTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(TEMPLATE_NAME_MAX_LENGTH),
  /** Null means "the person filing it chooses"; the create request must then name one. */
  departmentId: z.uuid().nullable(),
  priority: ticketPrioritySchema,
  subject: z.string(),
  bodyText: z.string(),
  /** Tags applied on creation. Tags the brand has since deleted are filtered out. */
  defaultTagIds: z.array(z.uuid()),
  customDefaults: z.record(z.string(), z.unknown()),
  /** How many tickets have been created from it. */
  usageCount: z.int().nonnegative(),
});
export type TicketTemplate = z.infer<typeof ticketTemplateSchema>;

export const ticketTemplateListSchema = z.object({ templates: z.array(ticketTemplateSchema) });
export type TicketTemplateList = z.infer<typeof ticketTemplateListSchema>;

export const ticketTemplateCreateRequestSchema = z.object({
  name: templateNameSchema,
  departmentId: z.uuid().nullish(),
  priority: ticketPrioritySchema.default('medium'),
  subject: templateSubjectSchema,
  bodyText: templateBodySchema,
  defaultTagIds: z.array(z.uuid()).max(MAX_TAGS_PER_BRAND).default([]),
  customDefaults: z.record(z.string(), z.unknown()).default({}),
});
export type TicketTemplateCreateRequest = z.infer<typeof ticketTemplateCreateRequestSchema>;

export const ticketTemplateUpdateRequestSchema = z
  .object({
    name: templateNameSchema.optional(),
    departmentId: z.uuid().nullable().optional(),
    priority: ticketPrioritySchema.optional(),
    subject: templateSubjectSchema.optional(),
    bodyText: templateBodySchema.optional(),
    defaultTagIds: z.array(z.uuid()).max(MAX_TAGS_PER_BRAND).optional(),
    customDefaults: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  );
export type TicketTemplateUpdateRequest = z.infer<typeof ticketTemplateUpdateRequestSchema>;

/**
 * What the template looks like filled in. The preview is a read: it resolves
 * the placeholders against a contact when one is named and against the brand
 * always, and leaves every placeholder it does not know spelled out, so an
 * author can see that `{{contcat.name}}` is a typo rather than an empty string.
 */
export const ticketTemplatePreviewSchema = z.object({
  subject: z.string(),
  bodyText: z.string(),
  /** Placeholders the template uses that this renderer does not know. */
  unknownPlaceholders: z.array(z.string()),
});
export type TicketTemplatePreview = z.infer<typeof ticketTemplatePreviewSchema>;

export const ticketTemplatePreviewQuerySchema = z.object({
  /** Whose name to put in. Omitted, the contact placeholders stay literal. */
  contactId: z.uuid().optional(),
});
export type TicketTemplatePreviewQuery = z.infer<typeof ticketTemplatePreviewQuerySchema>;

export const ticketTemplateParamSchema = z.object({
  brandId: z.uuid(),
  templateId: z.uuid(),
});
export type TicketTemplateParam = z.infer<typeof ticketTemplateParamSchema>;
