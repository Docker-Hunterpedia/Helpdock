import { z } from 'zod';
import { aiBudgetWindowSchema } from './ai.js';
import { localeSchema } from './brand.js';
import { hcVisibilitySchema } from './help-center.js';
import { knowledgeSourceKindSchema, knowledgeVisibilitySchema } from './knowledge.js';
import { ticketPrioritySchema } from './ticket.js';

/**
 * Agent assist (M7-05), the fields the assistant suggests (M7-05, M7-07), the
 * articles drafted from tickets and their approval (M7-05), and voice
 * transcripts (M7-09). Every request runs one model call through
 * `complete()` of `@helpdock/ai`, which redacts PII first and logs the call to
 * `ai_calls`; each answer carries {@link assistCallMetaSchema}, the figures
 * the admin's AI log disclosure shows.
 */

// ------------------------------------------------------------------ refusals

export const assistRefusalSchema = z.enum([
  /** The brand turned agent assist off (AI › Assistant). */
  'assist-off',
  /** A budget window is spent and the brand does not keep assist on past it. */
  'budget-exceeded',
  /** Neither the brand nor the install names a model. */
  'not-configured',
  /** The provider failed or answered with an error; the call is logged. */
  'provider-failed',
  /** "Draft article from ticket" waits for the ticket to close. */
  'ticket-not-closed',
  /** The ticket already has a proposal waiting for approval. */
  'proposal-exists',
  /** The proposal was approved or rejected already. */
  'proposal-decided',
  /** The thread has no customer message to work from. */
  'nothing-to-work-from',
  /** The model's answer could not be read as what was asked for. */
  'unreadable-answer',
]);
export type AssistRefusal = z.infer<typeof assistRefusalSchema>;

// ------------------------------------------------------------- shared pieces

export const assistToneSchema = z.enum(['friendlier', 'formal', 'shorter']);
export type AssistTone = z.infer<typeof assistToneSchema>;

/** What the AI log disclosure under an assist result shows, from its `ai_calls` row. */
export const assistCallMetaSchema = z.object({
  callId: z.string(),
  provider: z.string(),
  model: z.string(),
  tokensIn: z.int().nonnegative(),
  tokensOut: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  redactionCount: z.int().nonnegative(),
  redactionKinds: z.array(z.enum(['email', 'phone', 'card', 'iban'])),
});
export type AssistCallMeta = z.infer<typeof assistCallMetaSchema>;

export const assistCitationSchema = z.object({
  /** The `[n]` the text cites it by. */
  marker: z.int().positive(),
  title: z.string(),
  sourceKind: knowledgeSourceKindSchema,
  visibility: knowledgeVisibilitySchema,
  url: z.string().nullable(),
  articleId: z.uuid().nullable(),
  /** The PDF page, when the chunk names one. */
  page: z.int().positive().nullable(),
});
export type AssistCitation = z.infer<typeof assistCitationSchema>;

export const assistParamSchema = z.object({ brandId: z.uuid(), ticketId: z.uuid() });
export type AssistParam = z.infer<typeof assistParamSchema>;

// ---------------------------------------------------------------- the state

/** The proposal the ticket's last "Draft article" became, for the menu's caption. */
export const assistProposalRefSchema = z.object({
  id: z.uuid(),
  status: z.enum(['waiting', 'approved', 'rejected']),
});

export const fieldSuggestionsSchema = z.object({
  /** Existing tags only, by id. */
  tagIds: z.array(z.uuid()),
  priority: ticketPrioritySchema.nullable(),
  departmentId: z.uuid().nullable(),
  /** `assist`, or `rule:<id>` for a triage action. */
  source: z.string(),
  createdAt: z.iso.datetime(),
});
export type FieldSuggestions = z.infer<typeof fieldSuggestionsSchema>;

/**
 * What the composer's Assist menu and the Suggested fields card read when a
 * ticket opens: whether assist runs for this brand, why not, the budget banner
 * and what is pending.
 */
export const assistStateSchema = z.object({
  /** The brand's agent assist mode. Off hides the Assist button. */
  enabled: z.boolean(),
  /** Null when assist can run; otherwise why every item is disabled. */
  blocked: z.enum(['budget-exceeded', 'not-configured']).nullable(),
  /** The windows at 80 % or more, for the banner. */
  budget: z.array(aiBudgetWindowSchema.extend({ resetsAt: z.iso.datetime() })),
  /** At the hard stop the brand keeps assist on for staff. */
  keepAssistAfterHardStop: z.boolean(),
  ticketClosed: z.boolean(),
  proposal: assistProposalRefSchema.nullable(),
  suggestions: fieldSuggestionsSchema.nullable(),
});
export type AssistState = z.infer<typeof assistStateSchema>;

// ----------------------------------------------------------------- features

export const suggestReplyResultSchema = z.object({
  text: z.string(),
  locale: localeSchema,
  citations: z.array(assistCitationSchema),
  /** Markers the model invented and validation removed (DOMAIN-RULES §5). */
  droppedCitations: z.int().nonnegative(),
  meta: assistCallMetaSchema,
});
export type SuggestReplyResult = z.infer<typeof suggestReplyResultSchema>;

/** The summary is for the agent, in the language they read the admin in. */
export const summarizeRequestSchema = z.strictObject({ locale: localeSchema });
export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;

export const summaryResultSchema = z.object({
  points: z.array(z.string()).min(1).max(8),
  messageCount: z.int().nonnegative(),
  generatedAt: z.iso.datetime(),
  meta: assistCallMetaSchema,
});
export type SummaryResult = z.infer<typeof summaryResultSchema>;

export const suggestFieldsResultSchema = z.object({
  suggestions: fieldSuggestionsSchema,
  meta: assistCallMetaSchema,
});
export type SuggestFieldsResult = z.infer<typeof suggestFieldsResultSchema>;

/** One field of a suggestion the agent accepted (through the ticket's own API) or dismissed. */
export const dismissSuggestionRequestSchema = z.strictObject({
  field: z.enum(['tag', 'priority', 'department']),
  /** For `tag`, which one. */
  tagId: z.uuid().optional(),
});
export type DismissSuggestionRequest = z.infer<typeof dismissSuggestionRequestSchema>;

export const dismissSuggestionResultSchema = z.object({
  /** What is left on the card; null once nothing is. */
  suggestions: fieldSuggestionsSchema.nullable(),
});
export type DismissSuggestionResult = z.infer<typeof dismissSuggestionResultSchema>;

export const ASSIST_TEXT_MAX = 20_000;

export const translateRequestSchema = z
  .strictObject({
    /** A message of the ticket, read under the agent's own policy. */
    messageId: z.uuid().optional(),
    /** A voice note's transcript. */
    attachmentId: z.uuid().optional(),
    /** The agent's draft. */
    text: z.string().trim().min(1).max(ASSIST_TEXT_MAX).optional(),
    target: localeSchema,
  })
  .refine(
    (body) =>
      [body.messageId, body.attachmentId, body.text].filter((part) => part !== undefined).length ===
      1,
    'name exactly one of messageId, attachmentId and text',
  );
export type TranslateRequest = z.infer<typeof translateRequestSchema>;

export const translateResultSchema = z.object({
  text: z.string(),
  target: localeSchema,
  meta: assistCallMetaSchema,
});
export type TranslateResult = z.infer<typeof translateResultSchema>;

export const rewriteRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(ASSIST_TEXT_MAX),
  tone: assistToneSchema,
});
export type RewriteRequest = z.infer<typeof rewriteRequestSchema>;

export const rewriteResultSchema = z.object({
  text: z.string(),
  tone: assistToneSchema,
  meta: assistCallMetaSchema,
});
export type RewriteResult = z.infer<typeof rewriteResultSchema>;

export const draftArticleRequestSchema = z.strictObject({ locale: localeSchema });
export type DraftArticleRequest = z.infer<typeof draftArticleRequestSchema>;

export const ARTICLE_DRAFT_TITLE_MAX = 200;
export const ARTICLE_DRAFT_BODY_MAX = 40_000;

export const draftArticleResultSchema = z.object({
  title: z.string(),
  /** Paragraphs, `## ` headings and `- ` lists: the Markdown the assistant is asked for. */
  bodyMarkdown: z.string(),
  locale: localeSchema,
  messageCount: z.int().nonnegative(),
  citations: z.array(assistCitationSchema),
  meta: assistCallMetaSchema,
});
export type DraftArticleResult = z.infer<typeof draftArticleResultSchema>;

// ---------------------------------------------------- "Show redacted"

/** A contact message as the model would receive it, for "Show redacted". */
export const messageRedactionSchema = z.object({
  messageId: z.uuid(),
  redactedText: z.string(),
  count: z.int().positive(),
  kinds: z.array(z.enum(['email', 'phone', 'card', 'iban'])),
});
export type MessageRedaction = z.infer<typeof messageRedactionSchema>;

export const ticketRedactionsSchema = z.object({ items: z.array(messageRedactionSchema) });
export type TicketRedactions = z.infer<typeof ticketRedactionsSchema>;

// ------------------------------------------------------------- transcripts

export const transcriptStatusSchema = z.enum(['pending', 'done', 'failed']);
export type TranscriptStatus = z.infer<typeof transcriptStatusSchema>;

/** A voice note's transcript (M7-09). Staff only: no visitor response carries it. */
export const transcriptSchema = z.object({
  attachmentId: z.uuid(),
  status: transcriptStatusSchema,
  text: z.string().nullable(),
  /** Mapped to `en` or `ar` when the endpoint named one of them; otherwise null. */
  locale: localeSchema.nullable(),
  /** As the endpoint named it, for a language Helpdock has no catalog for. */
  language: z.string().nullable(),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const ticketTranscriptsSchema = z.object({ items: z.array(transcriptSchema) });
export type TicketTranscripts = z.infer<typeof ticketTranscriptsSchema>;

// --------------------------------------------------------------- proposals

export const proposalStatusSchema = z.enum(['waiting', 'approved', 'rejected']);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalCreateRequestSchema = z.strictObject({
  sectionId: z.uuid().nullable(),
  locale: localeSchema,
  title: z.string().trim().min(1).max(ARTICLE_DRAFT_TITLE_MAX),
  bodyMarkdown: z.string().trim().min(1).max(ARTICLE_DRAFT_BODY_MAX),
  note: z.string().trim().max(1_000).nullable(),
  /** The draft's call, so the reviewer sees its model, cost and redactions. */
  callId: z.uuid().nullable(),
  messageCount: z.int().nonnegative().max(10_000),
  citations: z
    .array(z.object({ title: z.string().max(300), articleId: z.uuid().nullable() }))
    .max(20),
});
export type ProposalCreateRequest = z.infer<typeof proposalCreateRequestSchema>;

export const proposalSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  locale: localeSchema,
  status: proposalStatusSchema,
  ticket: z.object({ id: z.uuid(), reference: z.string() }),
  proposedBy: z.string().nullable(),
  proposedAt: z.iso.datetime(),
});
export type ProposalSummary = z.infer<typeof proposalSummarySchema>;

export const proposalListSchema = z.object({
  items: z.array(proposalSummarySchema),
  waiting: z.int().nonnegative(),
});
export type ProposalList = z.infer<typeof proposalListSchema>;

export const proposalListQuerySchema = z.object({
  status: z.enum(['waiting', 'decided']).default('waiting'),
});
export type ProposalListQuery = z.infer<typeof proposalListQuerySchema>;

export const proposalDetailSchema = proposalSummarySchema.extend({
  sectionId: z.uuid().nullable(),
  bodyMarkdown: z.string(),
  /** The draft rendered and sanitised, read only until approved. */
  bodyHtml: z.string(),
  note: z.string().nullable(),
  messageCount: z.int().nonnegative(),
  ticketSubject: z.string(),
  ticketClosedAt: z.iso.datetime().nullable(),
  citations: z.array(z.object({ title: z.string(), articleId: z.uuid().nullable() })),
  call: z
    .object({
      model: z.string(),
      costUsd: z.number().nonnegative(),
      redactionCount: z.int().nonnegative(),
      redactionKinds: z.array(z.enum(['email', 'phone', 'card', 'iban'])),
    })
    .nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  rejectReason: z.string().nullable(),
  articleId: z.uuid().nullable(),
});
export type ProposalDetail = z.infer<typeof proposalDetailSchema>;

export const proposalParamSchema = z.object({ brandId: z.uuid(), proposalId: z.uuid() });
export type ProposalParam = z.infer<typeof proposalParamSchema>;

export const proposalApproveRequestSchema = z.strictObject({
  sectionId: z.uuid(),
  locale: localeSchema,
  visibility: hcVisibilitySchema,
});
export type ProposalApproveRequest = z.infer<typeof proposalApproveRequestSchema>;

export const proposalApproveResultSchema = z.object({ articleId: z.uuid() });
export type ProposalApproveResult = z.infer<typeof proposalApproveResultSchema>;

export const proposalRejectRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(1_000),
});
export type ProposalRejectRequest = z.infer<typeof proposalRejectRequestSchema>;

// ------------------------------------------------------- the outbox seams

/** M7-07: a rule's AI triage action, handed to the `ai.classify` job after commit. */
export const AI_TRIAGE_REQUESTED_EVENT = 'ai.triage_requested';

/** M7-09: an audio attachment is ready and the install transcribes. */
export const AI_TRANSCRIBE_REQUESTED_EVENT = 'ai.transcribe_requested';
