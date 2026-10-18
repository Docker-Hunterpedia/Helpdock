import { z } from 'zod';

const id = z.int().positive();
const instant = z.iso.datetime({ offset: true });
const nullId = id.nullish();
const fields = z.record(z.string(), z.json()).nullish();

export { type ZendeskCredentials, zendeskCredentialsSchema } from '@helpdock/schemas';

export const zendeskTicketSchema = z.looseObject({
  id,
  subject: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullish(),
  custom_status_id: nullId,
  requester_id: nullId,
  assignee_id: nullId,
  organization_id: nullId,
  group_id: nullId,
  collaborator_ids: z.array(id).optional(),
  email_cc_ids: z.array(id).optional(),
  tags: z.array(z.string()),
  custom_fields: z.array(z.object({ id, value: z.json() })).nullish(),
  created_at: instant,
  updated_at: instant,
  via: z.looseObject({ channel: z.string() }).nullish(),
});
export const zendeskUserSchema = z.looseObject({
  id,
  name: z.string(),
  role: z.enum(['end-user', 'agent', 'admin']),
  email: z.email().nullish(),
  phone: z.string().nullish(),
  suspended: z.boolean().optional(),
  active: z.boolean().optional(),
  deleted: z.boolean().optional(),
  organization_id: nullId,
  locale: z.string().nullish(),
  iana_time_zone: z.string().nullish(),
  external_id: z.string().nullish(),
  user_fields: fields,
  created_at: instant.optional(),
  updated_at: instant.optional(),
  notes: z.string().nullish(),
  details: z.string().nullish(),
  time_zone: z.string().nullish(),
});
export const zendeskOrganizationSchema = z.looseObject({
  id,
  name: z.string(),
  domain_names: z.array(z.string()),
  notes: z.string().nullish(),
  details: z.string().nullish(),
  organization_fields: fields,
  created_at: instant.optional(),
  updated_at: instant.optional(),
});
export const zendeskGroupSchema = z.looseObject({ id, name: z.string() });
export const zendeskIdentitySchema = z.looseObject({
  id,
  type: z.string(),
  value: z.string(),
  primary: z.boolean().optional(),
  verification_method: z.string().optional(),
});

export const zendeskCursorSchema = z
  .strictObject({
    after: z.string().min(1).max(8192).optional(),
    startTime: z.int().nonnegative().optional(),
  })
  .refine((cursor) => (cursor.after === undefined) !== (cursor.startTime === undefined), {
    message: 'A Zendesk export checkpoint requires one cursor or start time',
  });
export const zendeskOffsetSchema = z.strictObject({ page: z.int().positive() });
export const zendeskCursorEnvelopeSchema = z.looseObject({
  after_cursor: z.string().min(1).max(8192),
  end_of_stream: z.boolean(),
});
export const zendeskTimeEnvelopeSchema = z.looseObject({
  end_time: z.int().nonnegative(),
  end_of_stream: z.boolean(),
});
export const zendeskListEnvelopeSchema = z.looseObject({
  next_page: z.url().nullable(),
  count: z.int().nonnegative().optional(),
});

export const zendeskAttachmentSchema = z.looseObject({
  id,
  file_name: z.string().min(1),
  content_url: z.url(),
  content_type: z.string().optional(),
  size: z.int().nonnegative().optional(),
});
export const zendeskCommentSchema = z.looseObject({
  id,
  author_id: id,
  public: z.boolean(),
  created_at: instant,
  html_body: z.string().nullish(),
  body: z.string().nullish(),
  plain_body: z.string().nullish(),
  attachments: z.array(zendeskAttachmentSchema).max(1000),
});
export const zendeskCommentPageSchema = z.looseObject({
  comments: z.array(zendeskCommentSchema).max(100),
  meta: z.object({ has_more: z.boolean(), after_cursor: z.string().nullable().optional() }),
  links: z.object({ next: z.url().nullable() }),
});
