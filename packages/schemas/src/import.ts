import { z } from 'zod';

export const importSourceSchema = z.enum([
  'zendesk',
  'freshdesk',
  'zohodesk',
  'helpscout',
  'intercom',
  'gorgias',
  'zammad',
  'front',
  'file',
]);
export const importEntitySchema = z.enum([
  'user',
  'contact',
  'organization',
  'group',
  'field',
  'tag',
  'ticket',
  'message',
  'attachment',
  'csat',
  'category',
  'section',
  'article',
  'activity',
]);
export type ImportSource = z.infer<typeof importSourceSchema>;
export type ImportEntity = z.infer<typeof importEntitySchema>;
export const FRESHDESK_IMPORT_ENTITIES: readonly ImportEntity[] = [
  'user',
  'contact',
  'organization',
  'group',
  'field',
  'tag',
  'ticket',
  'message',
  'attachment',
  'csat',
  'category',
  'section',
  'article',
];
export const ZOHODESK_IMPORT_ENTITIES: readonly ImportEntity[] = [
  'user',
  'contact',
  'organization',
  'group',
  'field',
  'tag',
  'ticket',
  'message',
  'attachment',
  'csat',
  'category',
  'section',
  'article',
];

const externalId = z.string().min(1).max(200).regex(/\S/);
const shortText = z.string().max(300);
const name = z.string().min(1).max(200);
const instant = z.iso.datetime({ offset: true });
const custom = z.record(z.string().max(200), z.json());
const emails = z.array(z.email().max(320)).max(100);
const localized = z.strictObject({
  en: z.string().max(20000).optional(),
  ar: z.string().max(20000).optional(),
});
const body = z.string().max(2 * 1024 * 1024);

/** Fetching still requires the importer host policy and safeFetch; parsing grants no network access. */
export const importUrlSchema = z
  .url()
  .max(8192)
  .refine((address) => {
    if (!URL.canParse(address)) return false;
    const parsed = new URL(address);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }, 'Expected an HTTP(S) URL without embedded credentials');

/** ZIP members are relative POSIX paths under attachments/, never filesystem destinations. */
export const importBundlePathSchema = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path.startsWith('attachments/') &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Expected a relative attachment path without traversal',
  );

export const importUserSchema = z.strictObject({
  externalId,
  kind: z.enum(['agent', 'customer', 'unknown']),
  name,
  email: z.email().max(320).optional(),
  phone: z.string().max(80).optional(),
  role: shortText.optional(),
  active: z.boolean(),
  groups: z.array(shortText).max(1000).optional(),
});
export const importOrganizationSchema = z.strictObject({
  externalId,
  name,
  domains: z.array(z.string().max(253)).max(100),
  notes: body.optional(),
  description: body.optional(),
  createdAt: instant.optional(),
  updatedAt: instant.optional(),
  custom,
});
export const importContactSchema = z.strictObject({
  externalId,
  name,
  emails,
  phones: z.array(z.string().max(80)).max(100),
  organizationExternalId: externalId.optional(),
  locale: z.string().max(80).optional(),
  timezone: z.string().max(100).optional(),
  externalRef: shortText.optional(),
  custom,
  notes: body.optional(),
  description: body.optional(),
  createdAt: instant.optional(),
  updatedAt: instant.optional(),
  sourceIdentities: z
    .array(
      z.strictObject({
        externalId,
        type: z.string().min(1).max(100),
        value: z.string().max(8192),
        primary: z.boolean().optional(),
        verificationMethod: z.string().max(100).optional(),
      }),
    )
    .max(1000)
    .optional(),
});
export const importGroupSchema = z.strictObject({ externalId, name });
export const importTagSchema = z.strictObject({ externalId, name: z.string().min(1).max(80) });
export const importFieldSchema = z
  .strictObject({
    externalId,
    target: z.enum(['ticket', 'contact', 'organization']),
    key: z.string().min(1).max(200),
    label: name,
    type: z.enum(['text', 'textarea', 'number', 'date', 'checkbox', 'select', 'multiselect']),
    options: z
      .array(z.strictObject({ value: shortText, label: name }))
      .max(1000)
      .optional(),
  })
  .refine((field) => !['select', 'multiselect'].includes(field.type) || !!field.options?.length, {
    path: ['options'],
    message: 'Selection fields require options',
  });

export const importTicketSchema = z
  .strictObject({
    externalId,
    number: z.string().max(50).optional(),
    subject: z.string().min(1).max(10000),
    status: shortText,
    statusLabel: z.string().min(1).max(300).optional(),
    priority: shortText.optional(),
    channel: shortText.optional(),
    requesterExternalId: externalId.optional(),
    assigneeExternalId: externalId.optional(),
    groupExternalId: externalId.optional(),
    organizationExternalId: externalId.optional(),
    ccEmails: emails,
    ccExternalIds: z.array(externalId).max(100).optional(),
    tags: z.array(z.string().max(200)).max(1000),
    custom,
    createdAt: instant,
    updatedAt: instant,
    solvedAt: instant.optional(),
    closedAt: instant.optional(),
    sourceUrl: importUrlSchema.optional(),
  })
  .refine((ticket) => Date.parse(ticket.updatedAt) >= Date.parse(ticket.createdAt), {
    path: ['updatedAt'],
    message: 'Update precedes creation',
  });

export const importAttachmentRefSchema = z
  .strictObject({
    externalId,
    fileName: z.string().min(1).max(255),
    contentType: z.string().max(255).optional(),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    url: importUrlSchema.optional(),
    bundlePath: importBundlePathSchema.optional(),
    /** Transport-only hint for bounded metadata refresh; never part of business identity. */
    sourcePage: z.number().int().min(1).max(1000000).optional(),
    /** Vendor-provided locators rewritten to the managed file; never independent fetch authority. */
    sourceUrls: z.array(importUrlSchema).min(1).max(8).optional(),
  })
  .refine(
    (attachment) => !!attachment.url !== !!attachment.bundlePath,
    'An attachment requires exactly one URL or bundle path',
  )
  .refine(
    (attachment) => attachment.sourceUrls === undefined || attachment.url !== undefined,
    'URL aliases require a URL attachment',
  );
export const importAttachmentSchema = importAttachmentRefSchema.safeExtend({
  ticketExternalId: externalId,
  messageExternalId: externalId.optional(),
});
export const importMessageDetailsSchema = z.strictObject({
  status: shortText.optional(),
  channel: shortText.optional(),
  direction: shortText.optional(),
  authorKind: z.enum(['agent', 'customer', 'system', 'unknown']).optional(),
  authorType: shortText.optional(),
  via: shortText.optional(),
  mailSubject: z.string().max(10000).optional(),
  mailDate: z.string().max(1000).optional(),
  mailReturnPath: z.string().max(1000).optional(),
});
export const importMessageSchema = z
  .strictObject({
    externalId,
    ticketExternalId: externalId,
    authorExternalId: externalId.optional(),
    authorKind: z.enum(['agent', 'customer', 'system']),
    authorName: name.optional(),
    sourceDetails: importMessageDetailsSchema.optional(),
    public: z.boolean(),
    bodyHtml: body.optional(),
    bodyText: body.optional(),
    createdAt: instant,
    via: shortText.optional(),
    email: z
      .strictObject({
        messageId: z
          .string()
          .min(1)
          .max(998)
          .refine((id) => !id.includes('\r') && !id.includes('\n') && !id.includes('\u0000'))
          .optional(),
        from: z.email().optional(),
        to: emails.optional(),
        cc: emails.optional(),
        sentAt: instant.nullable().optional(),
      })
      .optional(),
    attachments: z.array(importAttachmentRefSchema).max(1000),
  })
  .refine(
    (message) => message.bodyHtml !== undefined || message.bodyText !== undefined,
    'A message requires HTML or plain text',
  );
export const importCsatSchema = z
  .strictObject({
    externalId,
    ticketExternalId: externalId,
    rating: z.number().int().min(1).max(5).nullable(),
    comment: body.optional(),
    ratedAt: instant,
    closedAt: instant.optional(),
    sourceDetails: custom.optional(),
  })
  .refine(
    (answer) => answer.rating !== null || answer.sourceDetails?.ratingUnmapped === true,
    'An unscored imported answer requires an explicit unmapped-rating marker',
  );
export const importActivitySchema = z.strictObject({
  externalId,
  ticketExternalId: externalId,
  authorExternalId: externalId.optional(),
  authorKind: z.enum(['agent', 'customer', 'system']),
  action: z.string().min(1).max(300),
  from: custom.optional(),
  to: custom.optional(),
  details: custom.optional(),
  createdAt: instant,
});
export const importCategorySchema = z
  .strictObject({
    externalId,
    parentExternalId: externalId.optional(),
    names: localized,
    descriptions: localized.optional(),
  })
  .refine((category) => !!category.names.en?.trim() || !!category.names.ar?.trim(), {
    path: ['names'],
    message: 'An English or Arabic name is required',
  });
export const importSectionSchema = importCategorySchema.safeExtend({
  parentExternalId: externalId,
  parentSectionExternalId: externalId.optional(),
});
const assetOrigin = importUrlSchema
  .refine((address) => {
    const parsed = new URL(address);
    return parsed.pathname === '/' && !parsed.search && !parsed.hash;
  }, 'Expected an origin without a path, query or fragment')
  .transform((address) => new URL(address).origin);

export const importPublishedArticleSchema = z
  .strictObject({
    title: z.string().min(1).max(500),
    bodyHtml: body,
    assetOrigin: assetOrigin.optional(),
    description: z.string().max(20000).optional(),
    publishedAt: instant.nullable(),
    attachments: z.array(importAttachmentRefSchema).max(1000).optional(),
  })
  .refine(
    (snapshot) =>
      new Set(snapshot.attachments?.map((file) => file.externalId) ?? []).size ===
      (snapshot.attachments?.length ?? 0),
    {
      path: ['attachments'],
      message: 'A published snapshot repeats an attachment identity',
    },
  );
export const importArticleSchema = z
  .strictObject({
    externalId,
    sectionExternalId: externalId,
    locale: z.enum(['en', 'ar']),
    title: z.string().min(1).max(500),
    bodyHtml: body,
    assetOrigin: assetOrigin.optional(),
    description: z.string().max(20000).optional(),
    draft: z.boolean(),
    internal: z.boolean(),
    createdAt: instant,
    updatedAt: instant,
    translationOf: externalId.optional(),
    attachments: z.array(importAttachmentRefSchema).max(1000).optional(),
    published: importPublishedArticleSchema.nullable().optional(),
  })
  .refine(
    (article) =>
      new Set(article.attachments?.map((file) => file.externalId) ?? []).size ===
      (article.attachments?.length ?? 0),
    {
      path: ['attachments'],
      message: 'An article repeats an attachment identity',
    },
  )
  .refine((article) => article.published !== null || article.draft, {
    path: ['published'],
    message: 'A public article must have a published copy',
  })
  .refine((article) => Date.parse(article.updatedAt) >= Date.parse(article.createdAt), {
    path: ['updatedAt'],
    message: 'Update precedes creation',
  });

/** The entity discriminant selects exactly one validated payload, including its source ID. */
export const importRecordSchema = z.discriminatedUnion('entity', [
  z.strictObject({ entity: z.literal('user'), payload: importUserSchema }),
  z.strictObject({ entity: z.literal('contact'), payload: importContactSchema }),
  z.strictObject({ entity: z.literal('organization'), payload: importOrganizationSchema }),
  z.strictObject({ entity: z.literal('group'), payload: importGroupSchema }),
  z.strictObject({ entity: z.literal('field'), payload: importFieldSchema }),
  z.strictObject({ entity: z.literal('tag'), payload: importTagSchema }),
  z.strictObject({ entity: z.literal('ticket'), payload: importTicketSchema }),
  z.strictObject({ entity: z.literal('message'), payload: importMessageSchema }),
  z.strictObject({ entity: z.literal('attachment'), payload: importAttachmentSchema }),
  z.strictObject({ entity: z.literal('csat'), payload: importCsatSchema }),
  z.strictObject({ entity: z.literal('category'), payload: importCategorySchema }),
  z.strictObject({ entity: z.literal('section'), payload: importSectionSchema }),
  z.strictObject({ entity: z.literal('article'), payload: importArticleSchema }),
  z.strictObject({ entity: z.literal('activity'), payload: importActivitySchema }),
]);
export type ImportRecord = z.infer<typeof importRecordSchema>;
export type ImportTicket = z.infer<typeof importTicketSchema>;
export type ImportCsat = z.infer<typeof importCsatSchema>;
export type ImportMessage = z.infer<typeof importMessageSchema>;
export type ImportActivity = z.infer<typeof importActivitySchema>;
export type ImportAttachmentRef = z.infer<typeof importAttachmentRefSchema>;

export const importManifestSchema = z.strictObject({
  format: z.literal('helpdock-import'),
  version: z.literal(1),
  source: importSourceSchema,
  exportedAt: instant,
  counts: z.partialRecord(importEntitySchema, z.number().int().nonnegative()),
});
export type ImportManifest = z.infer<typeof importManifestSchema>;
