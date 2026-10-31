import { z } from 'zod';
import { presenceStatusSchema } from './realtime.js';

/**
 * The `@` picker in an internal note (M14-15): the people a note on one ticket
 * can mention, each with the handle the notification resolver already
 * understands, so choosing one writes text that notifies exactly them.
 */

export const MENTION_QUERY_MAX = 80;
export const MENTION_CANDIDATES_MAX = 20;

export const mentionCandidateQuerySchema = z.object({
  /** Matched against the name and the handle, in either script. */
  q: z.string().trim().max(MENTION_QUERY_MAX).optional(),
});
export type MentionCandidateQuery = z.infer<typeof mentionCandidateQuerySchema>;

export const mentionCandidateSchema = z.object({
  userId: z.uuid(),
  name: z.string().min(1),
  /** What goes after the `@`. */
  handle: z.string().min(1),
  presence: presenceStatusSchema,
});
export type MentionCandidate = z.infer<typeof mentionCandidateSchema>;

export const mentionCandidateListSchema = z.object({
  candidates: z.array(mentionCandidateSchema).max(MENTION_CANDIDATES_MAX),
});
export type MentionCandidateList = z.infer<typeof mentionCandidateListSchema>;
