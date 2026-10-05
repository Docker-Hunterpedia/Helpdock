import type { AiProviderConfig, OAuthCredentialsValue } from '@helpdock/config';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getOAuthApiKey, getOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth';

/**
 * Turns a provider's stored credential into what a pi-ai call takes (ADR
 * 0016). An API key is used as it is. OAuth (subscription) credentials are
 * exchanged through pi-ai's OAuth entry point, which refreshes them when they
 * have expired; the refreshed set is handed back so the caller can store it,
 * because the next refresh needs the new refresh token.
 *
 * A key is always passed explicitly. pi-ai otherwise falls back to
 * environment variables such as `OPENAI_API_KEY`, and the settings — not
 * whatever the container happens to export — are what decides which account
 * an install bills.
 */

/** OpenAI's client refuses an empty key even for a server that ignores it. */
const UNUSED_KEY = 'unused';

export interface ResolvedCredential {
  readonly apiKey: string;
  /** Present when OAuth credentials were refreshed and must be saved. */
  readonly refreshed?: OAuthCredentialsValue;
}

/** OAuth credentials that pi-ai could not turn into a key: not logged in, or the refresh failed. */
export class ProviderCredentialError extends Error {
  constructor(providerId: string, reason: string) {
    super(`Provider ${providerId} has no usable credential: ${reason}`);
    this.name = 'ProviderCredentialError';
  }
}

export const resolveCredential = async (
  provider: AiProviderConfig,
): Promise<ResolvedCredential> => {
  switch (provider.auth.type) {
    case 'apiKey':
      return { apiKey: provider.auth.apiKey };
    case 'none':
      return { apiKey: UNUSED_KEY };
    case 'oauth': {
      const stored = provider.auth.credentials as OAuthCredentials;
      let result: Awaited<ReturnType<typeof getOAuthApiKey>>;
      try {
        result = await getOAuthApiKey(provider.kind, { [provider.kind]: stored });
      } catch (error) {
        throw new ProviderCredentialError(
          provider.id,
          error instanceof Error ? error.message : 'the token refresh failed',
        );
      }
      if (result === null) {
        throw new ProviderCredentialError(provider.id, 'pi-ai has no OAuth flow for this kind');
      }
      return result.newCredentials.access === stored.access
        ? { apiKey: result.apiKey }
        : { apiKey: result.apiKey, refreshed: result.newCredentials };
    }
  }
};

/**
 * Some subscriptions answer on an endpoint of their own (GitHub Copilot's
 * depends on the account), which pi-ai's OAuth provider knows how to set.
 */
export const modelForCredential = (provider: AiProviderConfig, model: Model<Api>): Model<Api> => {
  if (provider.auth.type !== 'oauth') {
    return model;
  }
  const oauth = getOAuthProvider(provider.kind);
  const modified = oauth?.modifyModels?.([model], provider.auth.credentials as OAuthCredentials);
  return modified?.[0] ?? model;
};
