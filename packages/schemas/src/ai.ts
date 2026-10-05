import { z } from 'zod';

/**
 * The AI admin API (M7-01, M7-02, M7-08): install-wide providers, the default
 * model and the embedding model on one side; a brand's model override,
 * guardrails, budget and system prompt on the other; and the AI calls logged
 * on a ticket. The `Admin/AI-Providers` and `Admin/AI-Assistant` screens of
 * M7-10 are built against these.
 *
 * **No credential is ever in a response.** A provider says which kind of
 * credential it holds and, for OAuth, when it expires; the key itself is
 * write-only. A field left out of an update keeps what is stored.
 */

// ------------------------------------------------------------------ refusals

/** Which rule refused an AI settings change; the admin screens turn it into a sentence. */
export const aiRefusalSchema = z.enum([
  /** Pinned by an `HD_*` environment variable, so admin cannot change it. */
  'locked-by-environment',
  /** No provider with that id. */
  'unknown-provider',
  /** pi-ai has no provider of that kind. */
  'unknown-kind',
  /** The provider does not offer that model. */
  'unknown-model',
  /** A new provider, or a change of credential type, came without a credential. */
  'credential-required',
  /** pi-ai has no subscription (OAuth) flow for that kind. */
  'oauth-unsupported',
  /** The default model or a brand still uses the provider. */
  'provider-in-use',
  /** The provider could not be asked for its models. */
  'discovery-failed',
  /** The model or dimension changed and `confirmReembed` was not set. */
  'reembed-not-confirmed',
]);
export type AiRefusal = z.infer<typeof aiRefusalSchema>;

// ------------------------------------------------------------------ providers

/** The same slug rule as `aiProviderIdSchema` in `@helpdock/config`; a test in the api holds them together. */
export const aiProviderIdSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/,
    'must be a lower-case slug of 1 to 40 characters',
  );

export const aiProviderParamSchema = z.object({ providerId: aiProviderIdSchema });

export const aiAuthTypeSchema = z.enum(['apiKey', 'oauth', 'none']);
export type AiAuthType = z.infer<typeof aiAuthTypeSchema>;

export const aiProviderKindSchema = z.object({
  id: z.string(),
  /** Subscription (OAuth) credentials are accepted for it. */
  oauth: z.boolean(),
  needsBaseUrl: z.boolean(),
});
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>;

export const aiProviderViewSchema = z.object({
  id: aiProviderIdSchema,
  kind: z.string(),
  label: z.string(),
  baseUrl: z.string().nullable(),
  authType: aiAuthTypeSchema,
  /** When OAuth tokens expire; pi-ai refreshes them on the next call. */
  oauthExpiresAt: z.iso.datetime().nullable(),
});
export type AiProviderView = z.infer<typeof aiProviderViewSchema>;

export const aiDefaultModelSchema = z.object({
  providerId: aiProviderIdSchema.nullable(),
  modelId: z.string().nullable(),
});
export type AiDefaultModel = z.infer<typeof aiDefaultModelSchema>;

export const aiProvidersOverviewSchema = z.object({
  providers: z.array(aiProviderViewSchema),
  kinds: z.array(aiProviderKindSchema),
  defaults: aiDefaultModelSchema,
  /** Pinned by `HD_AI_PROVIDERS`, `HD_AI_DEFAULT_PROVIDER` or `HD_AI_DEFAULT_MODEL`. */
  locked: z.object({ providers: z.boolean(), defaults: z.boolean() }),
});
export type AiProvidersOverview = z.infer<typeof aiProvidersOverviewSchema>;

/** pi-ai's `OAuthCredentials`, as `npx @mariozechner/pi-ai login` writes them to `auth.json`. */
export const aiOAuthCredentialsSchema = z
  .object({ access: z.string().min(1), refresh: z.string().min(1), expires: z.number() })
  .catchall(z.unknown());

/**
 * Create or replace one provider. The credential may be left out on an edit
 * of a provider whose credential type stays the same, which keeps the stored
 * one; a new provider, or a change of type, must bring one.
 */
export const aiProviderUpsertSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  baseUrl: z.url({ protocol: /^https?$/ }).nullable(),
  auth: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('apiKey'), apiKey: z.string().min(1).max(4_096).optional() }),
    z.strictObject({ type: z.literal('oauth'), credentials: aiOAuthCredentialsSchema.optional() }),
    z.strictObject({ type: z.literal('none') }),
  ]),
});
export type AiProviderUpsert = z.infer<typeof aiProviderUpsertSchema>;

export const aiModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.int().nonnegative(),
  maxTokens: z.int().nonnegative(),
  reasoning: z.boolean(),
  inputPerMillionUsd: z.number().nonnegative(),
  outputPerMillionUsd: z.number().nonnegative(),
});
export const aiModelListSchema = z.object({ models: z.array(aiModelInfoSchema) });
export type AiModelList = z.infer<typeof aiModelListSchema>;

export const aiDefaultModelUpdateSchema = z.strictObject({
  providerId: aiProviderIdSchema,
  modelId: z.string().min(1).max(200),
});
export type AiDefaultModelUpdate = z.infer<typeof aiDefaultModelUpdateSchema>;

// ----------------------------------------------------------------- embeddings

/** pgvector's HNSW index covers at most this many dimensions (ADR 0005). */
export const EMBEDDING_MAX_DIMS = 2_000;

export const embeddingStatusSchema = z.enum(['unconfigured', 'reindexing', 'ready']);
export type EmbeddingStatus = z.infer<typeof embeddingStatusSchema>;

export const embeddingSpaceViewSchema = z.object({
  status: embeddingStatusSchema,
  activeModel: z.string().nullable(),
  activeDims: z.int().nullable(),
  targetModel: z.string().nullable(),
  targetDims: z.int().nullable(),
  lastError: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** Chunks of every brand already in the target model, and in all. */
  progress: z.object({ embedded: z.int().nonnegative(), total: z.int().nonnegative() }),
});
export type EmbeddingSpaceView = z.infer<typeof embeddingSpaceViewSchema>;

export const embeddingSettingsViewSchema = z.object({
  provider: z.string(),
  baseUrl: z.string(),
  model: z.string(),
  dims: z.int().nonnegative(),
  pricePerMillionTokens: z.number().nonnegative(),
  hasApiKey: z.boolean(),
  /** Settings keys pinned by the environment, such as `embedding.model`. */
  lockedKeys: z.array(z.string()),
  space: embeddingSpaceViewSchema,
});
export type EmbeddingSettingsView = z.infer<typeof embeddingSettingsViewSchema>;

/**
 * Saving a different model or dimension re-embeds every chunk of every brand
 * (ADR 0005), so it must be confirmed: `confirmReembed` is required whenever
 * the model or the dimension changes from what is stored.
 */
export const embeddingSettingsUpdateSchema = z.strictObject({
  provider: z.string().trim().min(1).max(64),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().trim().min(1).max(200),
  dims: z
    .int()
    .min(1)
    .max(EMBEDDING_MAX_DIMS, {
      message: `pgvector indexes at most ${EMBEDDING_MAX_DIMS} dimensions; choose a model, or a reduced dimension, at or below it (ADR 0005)`,
    }),
  pricePerMillionTokens: z.number().min(0).max(1_000),
  /** Left out to keep the stored key; an empty string clears it. */
  apiKey: z.string().max(4_096).optional(),
  confirmReembed: z.boolean().optional(),
});
export type EmbeddingSettingsUpdate = z.infer<typeof embeddingSettingsUpdateSchema>;

// -------------------------------------------------------------- transcription

/**
 * Voice transcription (M7-09's endpoint, configured on `Admin/AI-Providers`
 * by M7-10): a Whisper-compatible `POST …/audio/transcriptions` URL, the
 * model it is asked for and its key. An empty endpoint is "off".
 */
export const transcriptionSettingsViewSchema = z.object({
  endpoint: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  /** Settings keys pinned by the environment, such as `transcription.endpoint`. */
  lockedKeys: z.array(z.string()),
});
export type TranscriptionSettingsView = z.infer<typeof transcriptionSettingsViewSchema>;

export const transcriptionSettingsUpdateSchema = z.strictObject({
  /** An empty string turns transcription off. */
  endpoint: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]),
  model: z.string().trim().max(200),
  /** Left out to keep the stored key; an empty string clears it. */
  apiKey: z.string().max(4_096).optional(),
});
export type TranscriptionSettingsUpdate = z.infer<typeof transcriptionSettingsUpdateSchema>;

// ---------------------------------------------------------------- per brand

const usd = z.number().positive().max(1_000_000);

export const aiBudgetSchema = z.object({
  /** US dollars a UTC day; null for no limit. */
  dailyUsd: usd.nullable(),
  monthlyUsd: usd.nullable(),
});
export type AiBudget = z.infer<typeof aiBudgetSchema>;

export const aiBudgetWindowSchema = z.object({
  period: z.enum(['day', 'month']),
  level: z.enum(['ok', 'warning', 'exceeded']),
  spentUsd: z.number().nonnegative(),
  limitUsd: z.number().positive(),
});

/** The longest system prompt a brand may set. */
export const AI_SYSTEM_PROMPT_MAX_LENGTH = 8_000;

/** The longest handoff message, per language. */
export const AI_HANDOFF_MAX_LENGTH = 1_000;

/** The channels auto-reply can answer on (REQUIREMENTS §4.7). */
export const AI_AUTO_REPLY_CHANNELS = ['widget', 'email', 'telegram'] as const;
export const aiAutoReplyChannelSchema = z.enum(AI_AUTO_REPLY_CHANNELS);
export type AiAutoReplyChannel = z.infer<typeof aiAutoReplyChannelSchema>;

/** Below this confidence auto-reply hands off to a person instead of answering. */
export const AI_DEFAULT_THRESHOLD = 0.7;

const autoReplyChannelSchema = z.object({
  enabled: z.boolean(),
  /** 0 to 1 in steps of 0.05, as the SliderField sets it. */
  threshold: z.number().min(0).max(1),
});
export type AiAutoReplyChannelSettings = z.infer<typeof autoReplyChannelSchema>;

const offChannel = { enabled: false, threshold: AI_DEFAULT_THRESHOLD };

/**
 * Which AI modes a brand runs (M7-10, read by M7-05 agent assist and M7-06
 * auto-reply). Every mode starts off; a key a stored row lacks takes its
 * default, so a later mode does not need a migration of old rows.
 */
export const aiAssistantModesSchema = z.object({
  agentAssist: z.boolean().default(false),
  /** At the 100 % hard stop auto-reply always stops; this keeps agent assist on. */
  keepAssistAfterHardStop: z.boolean().default(true),
  autoReply: z
    .object({
      widget: autoReplyChannelSchema.default(offChannel),
      email: autoReplyChannelSchema.default(offChannel),
      telegram: autoReplyChannelSchema.default(offChannel),
    })
    .default({ widget: offChannel, email: offChannel, telegram: offChannel }),
  /** What the assistant says when it hands off; empty for the built-in wording. */
  handoffMessage: z
    .object({
      en: z.string().max(AI_HANDOFF_MAX_LENGTH).default(''),
      ar: z.string().max(AI_HANDOFF_MAX_LENGTH).default(''),
    })
    .default({ en: '', ar: '' }),
});
export type AiAssistantModes = z.infer<typeof aiAssistantModesSchema>;

/** A stored `ai_settings.modes` value, or null, as the modes it means. */
export const parseAiAssistantModes = (stored: unknown): AiAssistantModes =>
  aiAssistantModesSchema.parse(stored ?? {});

export const brandAiSettingsSchema = z.object({
  /** The brand's own model; both null when it uses the install default. */
  providerId: aiProviderIdSchema.nullable(),
  modelId: z.string().nullable(),
  systemPrompt: z.string(),
  /** The prompt for Arabic conversations; empty when `systemPrompt` serves both. */
  systemPromptAr: z.string(),
  piiRedaction: z.boolean(),
  injectionFilter: z.boolean(),
  budget: aiBudgetSchema,
  modes: aiAssistantModesSchema,
  /**
   * DOMAIN-RULES §3.1's `ai_counts_as_first_response`: the brand setting
   * Ticketing › SLAs edits too, shown here beside auto-reply.
   */
  aiCountsAsFirstResponse: z.boolean(),
  usage: z.object({
    todayUsd: z.number().nonnegative(),
    monthUsd: z.number().nonnegative(),
    windows: z.array(aiBudgetWindowSchema),
  }),
});
export type BrandAiSettings = z.infer<typeof brandAiSettingsSchema>;

/** The Admin's half: model, guardrails and budget. */
export const brandAiSettingsUpdateSchema = z
  .strictObject({
    providerId: aiProviderIdSchema.nullable(),
    modelId: z.string().min(1).max(200).nullable(),
    piiRedaction: z.boolean(),
    injectionFilter: z.boolean(),
    budget: aiBudgetSchema,
  })
  .refine((body) => (body.providerId === null) === (body.modelId === null), {
    message: 'name both a provider and a model, or neither',
    path: ['modelId'],
  });
export type BrandAiSettingsUpdate = z.infer<typeof brandAiSettingsUpdateSchema>;

const autoReplyChannelUpdateSchema = z.strictObject(autoReplyChannelSchema.shape);

/** The Admin's modes: agent assist, auto-reply per channel, handoff wording. */
export const brandAiModesUpdateSchema = z.strictObject({
  agentAssist: z.boolean(),
  keepAssistAfterHardStop: z.boolean(),
  autoReply: z.strictObject({
    widget: autoReplyChannelUpdateSchema,
    email: autoReplyChannelUpdateSchema,
    telegram: autoReplyChannelUpdateSchema,
  }),
  handoffMessage: z.strictObject({
    en: z.string().trim().max(AI_HANDOFF_MAX_LENGTH),
    ar: z.string().trim().max(AI_HANDOFF_MAX_LENGTH),
  }),
  aiCountsAsFirstResponse: z.boolean(),
});
export type BrandAiModesUpdate = z.infer<typeof brandAiModesUpdateSchema>;

/** The Team Leader's half: tone, language policy, forbidden topics (REQUIREMENTS §4.7). */
export const brandAiPromptUpdateSchema = z.strictObject({
  systemPrompt: z.string().max(AI_SYSTEM_PROMPT_MAX_LENGTH),
  /** Left out to keep the stored Arabic prompt. */
  systemPromptAr: z.string().max(AI_SYSTEM_PROMPT_MAX_LENGTH).optional(),
});
export type BrandAiPromptUpdate = z.infer<typeof brandAiPromptUpdateSchema>;

// ------------------------------------------------------------- on a ticket

export const aiRedactionSchema = z.object({
  placeholder: z.string(),
  kind: z.enum(['email', 'phone', 'card', 'iban']),
  original: z.string(),
});

export const aiCallViewSchema = z.object({
  id: z.uuid(),
  feature: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['ok', 'error', 'refused']),
  tokensIn: z.int().nonnegative(),
  tokensOut: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  latencyMs: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  /** The redacted prompt as sent; null once retention purged it. */
  prompt: z
    .object({
      system: z.string(),
      messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
    })
    .nullable(),
  response: z.string().nullable(),
  /** Placeholder → original, so the agent can read what the model could not (M7-08). */
  redactions: z.array(aiRedactionSchema),
  sources: z.array(z.unknown()),
  error: z.string().nullable(),
  bodiesPurgedAt: z.iso.datetime().nullable(),
});
export type AiCallView = z.infer<typeof aiCallViewSchema>;

export const ticketAiCallsSchema = z.object({ items: z.array(aiCallViewSchema) });
export type TicketAiCalls = z.infer<typeof ticketAiCallsSchema>;

export const ticketAiCallsParamSchema = z.object({ brandId: z.uuid(), ticketId: z.uuid() });

// ---------------------------------------------------------------- auto-reply

/**
 * Auto-reply on a conversation (M7-06, DOMAIN-RULES §9). The brand's
 * per-channel switches, threshold and handoff wording are the assistant modes
 * of the AI settings; these are the conversation's side.
 */

/**
 * Why the assistant stopped answering a conversation (DOMAIN-RULES §9): it
 * handed off below the threshold or on a citation it was not given, the
 * customer asked for a person, or a staff member replied or took the ticket.
 */
export const aiPauseReasonSchema = z.enum([
  'low_confidence',
  'invalid_citation',
  'customer_request',
  'staff_reply',
  'staff_assigned',
]);
export type AiPauseReason = z.infer<typeof aiPauseReasonSchema>;

/** A conversation's assistant state, on the ticket. `pausedAt` null: it may answer. */
export const ticketAiStateSchema = z.object({
  pausedAt: z.iso.datetime().nullable(),
  /** Null with `pausedAt` set: for the rest of the conversation. */
  pausedUntil: z.iso.datetime().nullable(),
  reason: aiPauseReasonSchema.nullable(),
});
export type TicketAiState = z.infer<typeof ticketAiStateSchema>;

export const aiCitationViewSchema = z.object({
  /** The number in the text, `[1]`. */
  marker: z.int().positive(),
  title: z.string(),
  url: z.string().nullable(),
  visibility: z.enum(['public', 'internal']),
});
export type AiCitationView = z.infer<typeof aiCitationViewSchema>;

export const aiFeedbackSchema = z.enum(['helpful', 'not_helpful']);
export type AiFeedback = z.infer<typeof aiFeedbackSchema>;

/**
 * What the thread draws for a message the assistant wrote or a pause it
 * caused: the answer with its sources and the figures of its AI log, the
 * handoff message, or the System event of a pause or a resume.
 */
export const ticketMessageAiSchema = z.object({
  kind: z.enum(['answer', 'handoff', 'paused', 'resumed']),
  /** The answer as plain text without the sources list the body carries for email and Telegram. */
  answer: z.string().nullable(),
  /** The `ai_calls` row behind it; null when no model was asked. */
  callId: z.uuid().nullable(),
  model: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  threshold: z.number().min(0).max(1).nullable(),
  citations: z.array(aiCitationViewSchema),
  reason: aiPauseReasonSchema.nullable(),
  /** The customer's "Was this helpful?" on an answer. */
  feedback: aiFeedbackSchema.nullable(),
});
export type TicketMessageAi = z.infer<typeof ticketMessageAiSchema>;

// ------------------------------------------------------------- the brand's log

/** One AI call in the brand's activity list (M7-10): counts and cost, no bodies. */
export const aiCallSummarySchema = z.object({
  id: z.uuid(),
  feature: z.string(),
  model: z.string(),
  status: z.enum(['ok', 'error', 'refused']),
  tokensIn: z.int().nonnegative(),
  tokensOut: z.int().nonnegative(),
  costUsd: z.number().nonnegative(),
  createdAt: z.iso.datetime(),
  /** The ticket the call was made for, when there is one the reader may open. */
  ticket: z.object({ id: z.uuid(), reference: z.string() }).nullable(),
});
export type AiCallSummary = z.infer<typeof aiCallSummarySchema>;

export const AI_CALLS_PAGE_SIZE = 20;

export const brandAiCallsQuerySchema = z.object({
  /** The `nextCursor` of the previous page. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(AI_CALLS_PAGE_SIZE),
});
export type BrandAiCallsQuery = z.infer<typeof brandAiCallsQuerySchema>;

export const brandAiCallsPageSchema = z.object({
  items: z.array(aiCallSummarySchema),
  /** Pass back as `cursor` for the next, older page. Null on the last one. */
  nextCursor: z.string().nullable(),
});
export type BrandAiCallsPage = z.infer<typeof brandAiCallsPageSchema>;
