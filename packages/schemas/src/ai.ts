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

export const brandAiSettingsSchema = z.object({
  /** The brand's own model; both null when it uses the install default. */
  providerId: aiProviderIdSchema.nullable(),
  modelId: z.string().nullable(),
  systemPrompt: z.string(),
  piiRedaction: z.boolean(),
  injectionFilter: z.boolean(),
  budget: aiBudgetSchema,
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

/** The Team Leader's half: tone, language policy, forbidden topics (REQUIREMENTS §4.7). */
export const brandAiPromptUpdateSchema = z.strictObject({
  systemPrompt: z.string().max(AI_SYSTEM_PROMPT_MAX_LENGTH),
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
