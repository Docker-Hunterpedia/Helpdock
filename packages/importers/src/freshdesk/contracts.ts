import { csatOriginalAnswerSchema, importUrlSchema } from '@helpdock/schemas';
import { z } from 'zod';

/** Freshdesk API v2 reference, checked 2026-10-17. Unknown vendor additions are stripped. */
export { type FreshdeskCredentials, freshdeskCredentialsSchema } from '@helpdock/schemas';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
const custom = z.record(z.string(), z.json());
const nullableText = z.string().nullable().optional();
const nullableId = id.nullable().optional();

export const freshdeskAttachmentSchema = z.object({
  id,
  name: z.string().min(1),
  content_type: z.string(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  attachment_url: importUrlSchema,
});
export const freshdeskTicketSchema = z.object({
  id,
  subject: z.string().nullable(),
  status: z.number().int(),
  priority: z.number().int(),
  source: z.number().int(),
  requester_id: id,
  responder_id: nullableId,
  group_id: nullableId,
  company_id: nullableId,
  cc_emails: z.array(z.email()).default([]),
  tags: z.array(z.string().max(200)).max(1000).default([]),
  custom_fields: custom.default({}),
  created_at: instant,
  updated_at: instant,
  description: nullableText,
  description_text: nullableText,
  attachments: z.array(freshdeskAttachmentSchema).default([]),
  spam: z.boolean().optional(),
  deleted: z.boolean().optional(),
  archived: z.boolean().optional(),
  stats: z
    .object({
      resolved_at: instant.nullable().optional(),
      closed_at: instant.nullable().optional(),
    })
    .optional(),
});
export const freshdeskConversationSchema = z.object({
  id,
  ticket_id: id,
  user_id: id,
  incoming: z.boolean(),
  private: z.boolean(),
  body: nullableText,
  body_text: nullableText,
  created_at: instant,
  updated_at: instant,
  source: z.number().int().optional(),
  from_email: nullableText,
  to_emails: z.array(z.email()).nullable().optional(),
  cc_emails: z.array(z.email()).nullable().optional(),
  attachments: z.array(freshdeskAttachmentSchema).default([]),
});
export const freshdeskContactSchema = z.object({
  id,
  name: z.string(),
  active: z.boolean(),
  email: nullableText,
  other_emails: z.array(z.email()).default([]),
  phone: nullableText,
  mobile: nullableText,
  company_id: nullableId,
  language: nullableText,
  time_zone: nullableText,
  unique_external_id: nullableText,
  description: nullableText,
  address: nullableText,
  job_title: nullableText,
  contact_type: nullableText,
  twitter_id: nullableText,
  social_handler: z.array(custom).max(10).nullable().optional(),
  tags: z.array(z.string()).max(1000).optional(),
  other_companies: z.array(custom).max(1000).nullable().optional(),
  devices: z.array(custom).max(1000).nullable().optional(),
  view_all_tickets: z.boolean().optional(),
  custom_fields: custom.default({}),
  created_at: instant,
  updated_at: instant,
  deleted: z.boolean().optional(),
  blocked: z.boolean().optional(),
});
export const freshdeskAgentSchema = z.object({
  id,
  ticket_scope: z.number().int(),
  group_ids: z.array(id),
  role_ids: z.array(id),
  type: z.string(),
  contact: freshdeskContactSchema.omit({ id: true, company_id: true }),
  created_at: instant,
  updated_at: instant,
});
export const freshdeskCompanySchema = z.object({
  id,
  name: z.string(),
  domains: z.array(z.string()).default([]),
  description: nullableText,
  note: nullableText,
  health_score: nullableText,
  account_tier: nullableText,
  renewal_date: nullableText,
  industry: nullableText,
  custom_fields: custom.default({}),
  created_at: instant,
  updated_at: instant,
});
export const freshdeskGroupSchema = z.object({ id, name: z.string() });
export const freshdeskFieldSchema = z.object({
  id,
  name: z.string(),
  label: z.string(),
  type: z.string(),
  default: z.boolean().optional(),
  unique: z.boolean().optional(),
  choices: z.union([z.array(z.json()), custom]).optional(),
  nested_ticket_fields: z
    .array(
      z.object({ id, name: z.string(), label: z.string(), level: z.number().int().min(2).max(3) }),
    )
    .max(2)
    .optional(),
});
export const freshdeskRatingSchema = z.object({
  id,
  ticket_id: id,
  survey_id: id,
  user_id: id,
  agent_id: nullableId,
  group_id: nullableId,
  feedback: nullableText,
  ratings: z.record(z.string(), z.number().int()),
  created_at: instant,
  updated_at: instant,
});
export const freshdeskSurveySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  state: z.string(),
});
export const freshdeskSurveyResponseSchema = z.object({
  id: z.string().min(1).max(150),
  survey_id: z.uuid(),
  survey_version_id: z.string().min(1).max(200),
  user_id: z.string().nullable(),
  agent_id: z.string().nullable(),
  group_id: z.string().nullable(),
  ticket_id: id,
  status: z.enum(['COMPLETE', 'PARTIAL_COMPLETE', 'PARTIAL']),
  answers: z
    .array(csatOriginalAnswerSchema)
    .max(1000)
    .refine(
      (answers) => new Set(answers.map((answer) => answer.question_id)).size === answers.length,
      'Duplicate survey question IDs',
    ),
  created_at: instant,
  updated_at: instant,
});
export const freshdeskCategorySchema = z.object({
  id,
  name: z.string(),
  description: nullableText,
  created_at: instant,
  updated_at: instant,
});
export const freshdeskFolderSchema = freshdeskCategorySchema.extend({
  parent_folder_id: nullableId,
  visibility: z.number().int(),
  articles_count: z.number().int().nonnegative().optional(),
  sub_folders_count: z.number().int().nonnegative().optional(),
  hierarchy: z
    .array(
      z.object({
        level: z.number().int().min(0).max(127),
        type: z.enum(['category', 'folder']),
        data: z.object({ id, name: z.string().optional(), language: z.string().optional() }),
      }),
    )
    .max(128)
    .optional(),
});
export const freshdeskArticleSchema = z.object({
  id,
  category_id: id,
  folder_id: id,
  title: z.string(),
  description: z.string(),
  description_text: nullableText,
  status: z.number().int(),
  agent_id: nullableId,
  created_at: instant,
  updated_at: instant,
  tags: z.array(z.string()).default([]),
});
