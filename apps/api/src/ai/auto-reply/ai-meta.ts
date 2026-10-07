import {
  aiFeedbackSchema,
  aiPauseReasonSchema,
  type TicketMessageAi,
  type WidgetMessage,
} from '@helpdock/schemas';
import { z } from 'zod';

/**
 * `ticket_messages.ai_meta` for what auto-reply writes (M7-06): an answer with
 * its sources and the figures of its call, the handoff message, or the System
 * event of a pause or a resume. Parsed on the way out, so a row written by
 * another feature, or by an older shape, maps to nothing rather than failing
 * the thread.
 */

export const storedCitationSchema = z.object({
  marker: z.int().positive(),
  chunkId: z.uuid(),
  title: z.string(),
  url: z.string().nullable(),
  articleId: z.uuid().nullable(),
  visibility: z.enum(['public', 'internal']),
});
export type StoredCitation = z.infer<typeof storedCitationSchema>;

export const storedAiMetaSchema = z.object({
  feature: z.literal('auto_reply'),
  kind: z.enum(['answer', 'handoff', 'paused', 'resumed']),
  /**
   * The answer alone, without the sources the body lists under it for email
   * and Telegram. The widget and the admin draw their own CitationList.
   */
  answer: z.string().nullable(),
  callId: z.uuid().nullable(),
  model: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  threshold: z.number().min(0).max(1).nullable(),
  citations: z.array(storedCitationSchema),
  reason: aiPauseReasonSchema.nullable(),
  feedback: aiFeedbackSchema.nullable(),
});
export type StoredAiMeta = z.infer<typeof storedAiMetaSchema>;

/** A meta with every optional figure empty, for the caller to fill in. */
export const aiMeta = (
  kind: StoredAiMeta['kind'],
  fields: Partial<Omit<StoredAiMeta, 'feature' | 'kind'>> = {},
): StoredAiMeta => ({
  feature: 'auto_reply',
  kind,
  answer: null,
  callId: null,
  model: null,
  confidence: null,
  threshold: null,
  citations: [],
  reason: null,
  feedback: null,
  ...fields,
});

export const readAiMeta = (value: unknown): StoredAiMeta | undefined => {
  const parsed = storedAiMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/** The staff thread's view: every citation, marked public or internal. */
export const toTicketMessageAi = (value: unknown): TicketMessageAi | undefined => {
  const meta = readAiMeta(value);
  if (meta === undefined) {
    return undefined;
  }
  return {
    kind: meta.kind,
    answer: meta.answer,
    callId: meta.callId,
    model: meta.model,
    confidence: meta.confidence,
    threshold: meta.threshold,
    citations: meta.citations.map(({ marker, title, url, visibility }) => ({
      marker,
      title,
      url,
      visibility,
    })),
    reason: meta.reason,
    feedback: meta.feedback,
  };
};

/**
 * The visitor's view: the answer or handoff, its public sources, and their
 * own feedback. No confidence, model or reason — a visitor never sees a score
 * (`Widget/AI-EN` board 3).
 */
export const toWidgetMessageAi = (value: unknown): WidgetMessage['ai'] => {
  const meta = readAiMeta(value);
  if (meta === undefined || (meta.kind !== 'answer' && meta.kind !== 'handoff')) {
    return undefined;
  }
  return {
    kind: meta.kind,
    citations: meta.citations
      .filter((citation) => citation.visibility === 'public')
      .map(({ marker, title, url, articleId }) => ({ marker, title, url, articleId })),
    feedback: meta.feedback,
  };
};
