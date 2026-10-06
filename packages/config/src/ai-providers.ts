import { aiProviderIdSchema } from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The shape of the `ai.providers` setting (M7-01): every model provider the
 * install is configured with, credentials included. The whole list is one
 * secret setting, so it is encrypted under `APP_MASTER_KEY` like any other
 * secret, invalidated across replicas like any other setting, and may be
 * pinned by the environment as `HD_AI_PROVIDERS` (a JSON array), which locks
 * it in admin (ARCHITECTURE §4).
 *
 * Declared here rather than in `@helpdock/ai` because the settings registry
 * sits below every other package and needs the schema, and because this
 * package is loaded by the admin build, which must not pull in pi-ai.
 */

/** A provider kind that is not one of pi-ai's built-ins: any OpenAI-compatible server. */
export const OPENAI_COMPATIBLE_KIND = 'openai-compatible';

/** The slug a provider is known by, as `@helpdock/schemas` defines it for the API too. */
export { aiProviderIdSchema };

/**
 * What pi-ai's OAuth helpers return and refresh (`OAuthCredentials`): an
 * access token, a refresh token and the expiry in epoch milliseconds, plus
 * whatever a provider adds (an enterprise domain, a project id).
 */
export const oauthCredentialsSchema = z
  .object({
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number(),
  })
  .catchall(z.unknown());

export const aiProviderAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('apiKey'), apiKey: z.string().min(1) }),
  z.object({ type: z.literal('oauth'), credentials: oauthCredentialsSchema }),
  // A local server (Ollama, vLLM) that asks for nothing.
  z.object({ type: z.literal('none') }),
]);

export const aiProviderConfigSchema = z
  .object({
    id: aiProviderIdSchema,
    /** A pi-ai provider id (`openai`, `anthropic`, `openrouter`, …) or `openai-compatible`. */
    kind: z.string().min(1).max(64),
    label: z.string().trim().min(1).max(80),
    /** Required for `openai-compatible`; overrides the built-in endpoint otherwise. */
    baseUrl: z.url({ protocol: /^https?$/ }).nullable(),
    auth: aiProviderAuthSchema,
  })
  .refine((provider) => provider.kind !== OPENAI_COMPATIBLE_KIND || provider.baseUrl !== null, {
    message: 'an openai-compatible provider needs a base URL',
    path: ['baseUrl'],
  });

export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type AiProviderAuth = z.infer<typeof aiProviderAuthSchema>;
export type OAuthCredentialsValue = z.infer<typeof oauthCredentialsSchema>;

/** Twenty is more than any install needs, and keeps the encrypted row small. */
export const MAX_AI_PROVIDERS = 20;

export const aiProvidersSchema = z
  .array(aiProviderConfigSchema)
  .max(MAX_AI_PROVIDERS)
  .refine(
    (providers) => new Set(providers.map((provider) => provider.id)).size === providers.length,
    {
      message: 'provider ids must be unique',
    },
  );
