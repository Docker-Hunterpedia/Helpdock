import { z } from 'zod';
import { ConnectorError } from '../errors.js';
import type { ZohoDeskClient } from './client.js';
import { zohoIdSchema } from './contracts.js';
import { zohoRootCategorySchema, zohoSectionSchema } from './knowledge-contracts.js';

export const zohoKnowledgePrivacySchema = z.strictObject({
  rootId: zohoIdSchema,
  nextId: zohoIdSchema.nullable(),
  seen: z.array(zohoIdSchema).max(128),
  internal: z.boolean(),
  draft: z.boolean(),
});
export type ZohoKnowledgePrivacy = z.infer<typeof zohoKnowledgePrivacySchema>;

/** Persist each ancestor hop so a throttled deep hierarchy does not restart its whole walk. */
export async function zohoKnowledgePrivacyStep(
  client: ZohoDeskClient,
  raw: ZohoKnowledgePrivacy,
): Promise<ZohoKnowledgePrivacy> {
  const state = zohoKnowledgePrivacySchema.parse(raw);
  if (state.nextId === null) return state;
  if (state.seen.includes(state.nextId) || state.seen.length >= 128)
    throw new ConnectorError('invalid-response');
  const root = state.nextId === state.rootId;
  const row = root
    ? await client.json(`/api/v1/kbRootCategories/${state.nextId}`, zohoRootCategorySchema)
    : await client.json(`/api/v1/kbSections/${state.nextId}`, zohoSectionSchema);
  if (row.id !== state.nextId) throw new ConnectorError('invalid-response');
  let nextId: string | null = null;
  if (!root) {
    const section = zohoSectionSchema.parse(row);
    if (section.rootCategoryId !== state.rootId || section.parentCategoryId === section.id)
      throw new ConnectorError('invalid-response');
    nextId = section.parentCategoryId;
  }
  const hidden = row.status !== 'SHOW_IN_HELPCENTER' || row.isTrashed;
  return zohoKnowledgePrivacySchema.parse({
    ...state,
    nextId,
    seen: [...state.seen, row.id],
    internal: state.internal || hidden || row.visibility !== 'ALL_USERS' || row.groups.length > 0,
    draft: state.draft || hidden,
  });
}
