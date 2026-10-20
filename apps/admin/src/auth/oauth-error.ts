/** The OAuth callback failures with a sentence of their own (1.0.1, ADR 0051). */
const OAUTH_ERROR_KEYS = {
  'oauth-link-required': 'auth:oauth.errors.oauth-link-required',
  'oauth-identity-conflict': 'auth:oauth.errors.oauth-identity-conflict',
} as const;

export function oauthErrorKey(code: string | null) {
  return code !== null && Object.hasOwn(OAUTH_ERROR_KEYS, code)
    ? OAUTH_ERROR_KEYS[code as keyof typeof OAUTH_ERROR_KEYS]
    : undefined;
}
