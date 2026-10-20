import type { OauthProvider } from '@helpdock/schemas';

/** How each sign-in provider is named on screen: a product name, Latin in both languages. */
export const PROVIDER_NAME_KEYS = {
  google: 'auth:signIn.google',
  microsoft: 'auth:signIn.microsoft',
  github: 'auth:signIn.github',
} as const satisfies Record<OauthProvider, string>;
