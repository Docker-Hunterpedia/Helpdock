import { importUrlSchema } from '@helpdock/schemas';
import { z } from 'zod';
import { zohoIdSchema } from './contracts.js';

export const zohoArticleLocaleSchema = z
  .string()
  .min(2)
  .max(50)
  .regex(/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{1,8})*$/);
export const zohoArticleVersionSchema = z
  .string()
  .max(50)
  .regex(/^\d+(?:\.\d+)*$/);
export const zohoArticleStatusSchema = z.enum([
  'Draft',
  'Published',
  'Review',
  'Expired',
  'Unpublished',
]);
const flag = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);
export const zohoArticleTranslationHintSchema = z.object({
  locale: zohoArticleLocaleSchema,
  translationId: zohoIdSchema,
  isTrashed: flag,
  latestVersion: zohoArticleVersionSchema.optional(),
});
const bytes = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
export const zohoArticleResourceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9]+$/);

export const zohoArticleAttachmentSchema = z.object({
  resourceId: zohoArticleResourceIdSchema,
  name: z.string().min(1).max(255),
  extension: z.string().max(50),
  size: bytes,
  downloadUrl: importUrlSchema,
  viewUrl: importUrlSchema,
  createdTime: z.iso.datetime({ offset: true }),
});
// The separately documented attachment-list example uses `filesize`, unlike article detail.
export const zohoArticleAttachmentListItemSchema = zohoArticleAttachmentSchema
  .omit({ size: true })
  .extend({ filesize: bytes });

export const zohoArticleIndexSchema = z.object({
  id: zohoIdSchema,
  translationId: zohoIdSchema,
  locale: zohoArticleLocaleSchema,
  sourceLocale: zohoArticleLocaleSchema,
  title: z.string().min(1).max(20000),
  status: zohoArticleStatusSchema,
  latestVersionStatus: zohoArticleStatusSchema,
  latestVersion: zohoArticleVersionSchema,
  latestPublishedVersion: zohoArticleVersionSchema.nullable(),
  permission: z.enum(['ALL', 'REGISTEREDUSERS', 'AGENTS']),
  isTrashed: flag,
  createdTime: z.iso.datetime({ offset: true }),
  modifiedTime: z.iso.datetime({ offset: true }),
  rootCategoryId: zohoIdSchema,
  categoryId: zohoIdSchema,
  summary: z.string().max(20000).nullable().optional(),
  availableLocaleTranslations: z.array(zohoArticleTranslationHintSchema).max(1000).optional(),
});
export const zohoArticleSchema = zohoArticleIndexSchema.extend({
  currentVersion: zohoArticleVersionSchema,
  answer: z.string().max(2_000_000),
  attachments: z.array(zohoArticleAttachmentSchema).max(1000),
});
export type ZohoArticle = z.infer<typeof zohoArticleSchema>;
export type ZohoArticleIndex = z.infer<typeof zohoArticleIndexSchema>;
