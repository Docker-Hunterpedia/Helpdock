import {
  passkeyFinishRequestSchema,
  passkeyProofSchema,
  passkeyRenameRequestSchema,
} from '@helpdock/schemas';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isPasskeyRoute, PASSKEY_BODY_LIMIT, registerPasskeyBodyLimit } from './passkey-body.js';

const CEREMONY_ID = 'A'.repeat(43);
const fill = (length: number): string => 'a'.repeat(length);

/** Every field at its cap in `passkeys.ts`: the largest body its schemas accept. */
const assertion = {
  id: fill(1400),
  rawId: fill(1400),
  type: 'public-key' as const,
  response: {
    clientDataJSON: fill(4096),
    authenticatorData: fill(8192),
    signature: fill(2048),
    userHandle: fill(256),
  },
  authenticatorAttachment: 'cross-platform' as const,
  clientExtensionResults: {},
};
const largestFinish = {
  ceremonyId: CEREMONY_ID,
  response: {
    id: fill(1400),
    rawId: fill(1400),
    type: 'public-key' as const,
    response: {
      clientDataJSON: fill(4096),
      attestationObject: fill(16_384),
      authenticatorData: fill(8192),
      transports: Array.from({ length: 8 }, () => fill(32)),
      publicKeyAlgorithm: -7,
      publicKey: fill(2048),
    },
    authenticatorAttachment: 'cross-platform' as const,
    clientExtensionResults: { credProps: { rk: true } },
  },
  name: fill(64),
};
const largestRename = {
  name: fill(64),
  proof: { passkey: { ceremonyId: CEREMONY_ID, response: assertion } },
};

describe('isPasskeyRoute', () => {
  it.each([
    '/api/auth/passkey/options',
    '/api/auth/passkey/verify',
    '/api/auth/passkey/second-factor/options',
    '/api/auth/enrolment/passkey/options',
    '/api/auth/enrolment/passkey/confirm',
    '/api/me/passkeys',
    '/api/me/passkeys?x=1',
    '/api/me/passkeys/begin',
    '/api/me/passkeys/finish',
    '/api/me/passkeys/step-up/options',
    '/api/me/passkeys/:id',
  ])('covers %s', (url) => {
    expect(isPasskeyRoute(url)).toBe(true);
  });

  it.each([
    '/api/me/profile/photo',
    '/api/me/profile',
    '/api/me/password',
    '/api/me/sessions',
    '/api/me/passkeys-other',
    '/api/auth/enrolment/start',
    '/api/auth/enrolment/confirm',
    '/api/auth/login',
    '/api/install/passkeys',
    '/x/api/me/passkeys',
  ])('leaves %s alone', (url) => {
    expect(isPasskeyRoute(url)).toBe(false);
  });
});

describe('the largest legitimate passkey body', () => {
  it('is what the schemas accept at their caps, and fits well under the limit', () => {
    expect(passkeyFinishRequestSchema.safeParse(largestFinish).success).toBe(true);
    expect(passkeyRenameRequestSchema.safeParse(largestRename).success).toBe(true);
    expect(passkeyProofSchema.safeParse(largestRename.proof).success).toBe(true);

    expect(JSON.stringify(largestFinish).length).toBeLessThan(PASSKEY_BODY_LIMIT);
    expect(JSON.stringify(largestRename).length).toBeLessThan(PASSKEY_BODY_LIMIT);
  });
});

describe('registerPasskeyBodyLimit', () => {
  const app = async () => {
    const fastify = Fastify();
    registerPasskeyBodyLimit(fastify);
    for (const url of ['/api/me/passkeys/finish', '/api/auth/passkey/verify', '/api/me/password']) {
      fastify.post(url, async () => ({ ok: true }));
    }
    await fastify.ready();
    return fastify;
  };
  const post = (fastify: Awaited<ReturnType<typeof app>>, url: string, payload: unknown) =>
    fastify.inject({ method: 'POST', url, payload: payload as object });

  it('answers 413 to a passkey body over 64 KiB', async () => {
    const fastify = await app();
    const oversized = { blob: fill(PASSKEY_BODY_LIMIT) };

    expect((await post(fastify, '/api/me/passkeys/finish', oversized)).statusCode).toBe(413);
    expect((await post(fastify, '/api/auth/passkey/verify', oversized)).statusCode).toBe(413);
    await fastify.close();
  });

  it('lets the largest legitimate registration body through', async () => {
    const fastify = await app();

    const response = await post(fastify, '/api/me/passkeys/finish', largestFinish);

    expect(response.statusCode).toBe(200);
    await fastify.close();
  });

  it('keeps the default limit on other /api/me routes', async () => {
    const fastify = await app();

    const response = await post(fastify, '/api/me/password', { blob: fill(PASSKEY_BODY_LIMIT) });

    expect(response.statusCode).toBe(200);
    await fastify.close();
  });
});
