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
export const articleLoadSchema = knowledgeScope.extend({
  record: importArticleSchema,
  preparedBodyHtml: hcVersionSaveRequestSchema.shape.bodyHtml,
});
export type CategoryLoad = z.infer<typeof categoryLoadSchema>;
export type SectionLoad = z.infer<typeof sectionLoadSchema>;
export type ArticleLoad = z.infer<typeof articleLoadSchema>;

export function importedNames(names: { en?: string | undefined; ar?: string | undefined }) {
  return hcNamesSchema.parse({ en: names.en ?? '', ar: names.ar ?? '' });
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
