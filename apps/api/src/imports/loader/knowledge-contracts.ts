import {
  HC_CATEGORY_DESCRIPTION_MAX,
  hcDescriptionsSchema,
  hcNamesSchema,
  hcVersionSaveRequestSchema,
  importArticleSchema,
  importCategorySchema,
  importSectionSchema,
  importSourceSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

const knowledgeScope = z.strictObject({
  brandId: z.uuid(),
  runId: z.uuid(),
  source: importSourceSchema,
});
export const categoryLoadSchema = knowledgeScope.extend({ record: importCategorySchema });
export const sectionLoadSchema = knowledgeScope.extend({ record: importSectionSchema });
export const articleLoadSchema = knowledgeScope
  .extend({
    record: importArticleSchema,
    preparedBodyHtml: hcVersionSaveRequestSchema.shape.bodyHtml,
    preparedPublishedBodyHtml: hcVersionSaveRequestSchema.shape.bodyHtml.optional(),
  })
  .superRefine((input, ctx) => {
    if ((input.record.published != null) !== (input.preparedPublishedBodyHtml !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['preparedPublishedBodyHtml'],
        message: 'Prepared published content must match the explicit source snapshot',
      });
  });
export type CategoryLoad = z.infer<typeof categoryLoadSchema>;
export type SectionLoad = z.infer<typeof sectionLoadSchema>;
export type ArticleLoad = z.infer<typeof articleLoadSchema>;

export function importedNames(names: { en?: string | undefined; ar?: string | undefined }) {
  return hcNamesSchema.parse({ en: names.en ?? '', ar: names.ar ?? '' });
}

export function importedBreadcrumbNames(
  parent: Record<string, string>,
  child: ReturnType<typeof importedNames>,
) {
  return importedNames({
    en: child.en ? [parent.en || parent.ar, child.en].filter(Boolean).join(' / ') : '',
    ar: child.ar ? [parent.ar || parent.en, child.ar].filter(Boolean).join(' / ') : '',
  });
}
export function importedDescriptions(
  descriptions: { en?: string | undefined; ar?: string | undefined } | undefined,
) {
  return hcDescriptionsSchema.parse({
    en: (descriptions?.en ?? '')
      .slice(0, HC_CATEGORY_DESCRIPTION_MAX)
      .replace(/[\uD800-\uDBFF]$/, ''),
    ar: (descriptions?.ar ?? '')
      .slice(0, HC_CATEGORY_DESCRIPTION_MAX)
      .replace(/[\uD800-\uDBFF]$/, ''),
  });
}

export function sourceDescriptions(
  descriptions: { en?: string | undefined; ar?: string | undefined } | undefined,
) {
  return { en: descriptions?.en ?? '', ar: descriptions?.ar ?? '' };
}
