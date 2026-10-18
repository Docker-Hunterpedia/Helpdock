import { hashImportValue } from '@helpdock/importers';
import { HC_BODY_MAX } from '@helpdock/schemas';
import { z } from 'zod';

export const preparedImportArticleSchema = z.strictObject({
  bodyHtml: z.string().max(HC_BODY_MAX),
  publishedBodyHtml: z.string().max(HC_BODY_MAX).optional(),
});
export type PreparedImportArticle = z.infer<typeof preparedImportArticleSchema>;
export const preparedImportArticleResultSchema = z.union([
  z
    .string()
    .max(HC_BODY_MAX)
    .transform((bodyHtml): PreparedImportArticle => ({ bodyHtml })),
  preparedImportArticleSchema,
]);

/** Existing single-copy checkpoints retain their hash; explicit snapshots seal both copies together. */
export function preparedImportArticleHash(prepared: PreparedImportArticle): string {
  return hashImportValue(prepared.publishedBodyHtml === undefined ? prepared.bodyHtml : prepared);
}
