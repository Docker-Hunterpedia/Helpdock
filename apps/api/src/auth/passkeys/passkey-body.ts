import type { FastifyInstance } from 'fastify';

/**
 * The most a passkey route reads (M18, #424). The largest legitimate body is a
 * registration response plus its ceremony id and name, about 34 KB at every
 * field's cap in `passkeys.ts`; a rename or removal carrying a passkey
 * assertion as its proof is about 18 KB. Fastify's default is 1 MB, and these
 * routes take their bodies from a browser that has not finished proving who it
 * is (the sign-in and enrolment ones run before any session).
 */
export const PASSKEY_BODY_LIMIT = 64 * 1024;

/**
 * `/api/auth/passkey/*`, `/api/auth/enrolment/passkey/*`, and `/api/me/passkeys`
 * with whatever follows it. `/api/me/passkeys-x` and the rest of `/api/me`
 * (the profile photo upload among them) are not covered.
 */
const PASSKEY_ROUTE =
  /^\/api\/(?:auth\/passkey\/|auth\/enrolment\/passkey\/|me\/passkeys(?:[/?]|$))/;

export const isPasskeyRoute = (url: string): boolean => PASSKEY_ROUTE.test(url);

/** Registered before Nest adds its routes, because the hook only sees routes added after it. */
export const registerPasskeyBodyLimit = (fastify: FastifyInstance): void => {
  fastify.addHook('onRoute', (route) => {
    if (isPasskeyRoute(route.url)) {
      route.bodyLimit = PASSKEY_BODY_LIMIT;
    }
  });
};
