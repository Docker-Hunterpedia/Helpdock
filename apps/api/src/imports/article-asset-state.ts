import { z } from 'zod';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const importArticleAssetRefusalSchema = z.enum([
  'source-unavailable',
  'mime_mismatch',
  'mime_not_allowed',
  'kind_disabled',
  'too_large',
  'unreadable',
  'infected',
]);
export const importArticleAssetOutcomeSchema = z.discriminatedUnion('state', [
  z.strictObject({ key: hash, state: z.enum(['processing', 'prepared']), assetId: z.uuid() }),
  z.strictObject({
    key: hash,
    state: z.literal('unavailable'),
    reason: importArticleAssetRefusalSchema,
  }),
]);
export const importArticlePreparationSchema = z
  .strictObject({
    version: z.literal(1),
    sourceHash: hash,
    outcomes: z.array(importArticleAssetOutcomeSchema).max(1000),
    bodyHash: hash.optional(),
  })
  .refine(
    (state) => new Set(state.outcomes.map((outcome) => outcome.key)).size === state.outcomes.length,
    { path: ['outcomes'], message: 'An article repeats an asset checkpoint' },
  );
export type ImportArticlePreparation = z.infer<typeof importArticlePreparationSchema>;
export type ImportArticleAssetOutcome = z.infer<typeof importArticleAssetOutcomeSchema>;

/** Pending media is normal progress, distinct from vendor throttling or a failed conversion. */
export class ImportArticleAssetsPending extends Error {
  constructor(readonly delayMs = 1000) {
    super('import.article-assets-pending');
    this.name = 'ImportArticleAssetsPending';
  }
}
