import type { SecondFactorOptions } from '@helpdock/schemas';

/**
 * What a redirect to the second-factor screen says about the ways to answer it
 * (M18-03). The usual account, with an authenticator app alone, adds nothing,
 * so links from before passkeys read the same as they always did.
 */
export const factorsParams = (factors: SecondFactorOptions): Record<string, string> =>
  factors.totp && !factors.passkey
    ? {}
    : {
        factors: [factors.totp ? 'totp' : null, factors.passkey ? 'passkey' : null]
          .filter((name) => name !== null)
          .join(','),
      };
