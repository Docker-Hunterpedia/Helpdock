import { randomUUID } from 'node:crypto';
import type { Settings } from '@helpdock/config';
import type { Redis } from 'ioredis';
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI } from 'jose';
import { z } from 'zod';
import type { Logger } from '../../logging/logger.js';
import { SIGNING_KEY_LOCK } from '../redis-keys.js';

/**
 * The ES256 key pair access tokens are signed with (ARCHITECTURE §7).
 *
 * It is generated at first boot and stored encrypted in the `settings` table,
 * not in `.env`, for one reason: every replica has to verify what any other
 * replica signed. A key per process would make a session usable on exactly one
 * of them. A key in `.env` would work too, but it would be one more thing an
 * operator has to generate correctly before the first start, and one more
 * secret in a file that is not encrypted at rest.
 *
 * Losing the key is not a data loss: every session is signed out and everybody
 * signs in again. That is also the whole of key rotation in v1 — clear the
 * setting, restart, sessions end.
 */

export const SIGNING_KEY_SETTING = 'auth.jwtSigningKey' as const;
export const SIGNING_ALGORITHM = 'ES256' as const;

/** How long one replica may hold the generation lock before another retries. */
const LOCK_SECONDS = 30;
/** How long a replica that lost the race waits for the winner's key to appear. */
const WAIT_TIMEOUT_MS = 15_000;
const WAIT_INTERVAL_MS = 250;

const storedKeySchema = z.object({
  /** JWK thumbprint of the public key. It goes in the JWS header. */
  kid: z.string().min(1),
  privateKeyPkcs8: z.string().startsWith('-----BEGIN PRIVATE KEY-----'),
  publicKeySpki: z.string().startsWith('-----BEGIN PUBLIC KEY-----'),
  createdAt: z.iso.datetime(),
});

/**
 * What `jose` hands back from an import. Spelled this way rather than as
 * `CryptoKey` because that name is a value in Node's globals and a type in the
 * DOM library, and this build has only the first.
 */
export type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

export interface SigningKeys {
  readonly kid: string;
  readonly privateKey: SigningKey;
  readonly publicKey: SigningKey;
}

/** Thrown when the stored key cannot be read back. Boot stops rather than signing nobody in. */
export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
  }
}

const importStored = async (stored: z.infer<typeof storedKeySchema>): Promise<SigningKeys> => ({
  kid: stored.kid,
  privateKey: await importPKCS8(stored.privateKeyPkcs8, SIGNING_ALGORITHM),
  publicKey: await importSPKI(stored.publicKeySpki, SIGNING_ALGORITHM),
});

const parseStored = (raw: string): z.infer<typeof storedKeySchema> => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new SigningKeyError(`${SIGNING_KEY_SETTING} is not valid JSON`);
  }

  const parsed = storedKeySchema.safeParse(decoded);
  if (!parsed.success) {
    throw new SigningKeyError(`${SIGNING_KEY_SETTING} does not hold an ES256 key pair`);
  }

  return parsed.data;
};

const generate = async (): Promise<z.infer<typeof storedKeySchema>> => {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALGORITHM, {
    extractable: true,
  });

  return {
    // A random id rather than a JWK thumbprint: the thumbprint is derived from
    // the public key, so publishing it would say something about the key, and
    // `kid` only has to name which key to try.
    kid: randomUUID(),
    privateKeyPkcs8: await exportPKCS8(privateKey),
    publicKeySpki: await exportSPKI(publicKey),
    createdAt: new Date().toISOString(),
  };
};

export interface LoadSigningKeysOptions {
  readonly settings: Settings;
  readonly redis: Redis;
  readonly logger: Logger;
  /** Overridden by the tests so a lost race does not take fifteen seconds. */
  readonly waitTimeoutMs?: number;
  readonly waitIntervalMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Returns the install's signing keys, generating them once if this is the first
 * boot.
 *
 * Several replicas starting together must end up with the *same* key, so
 * generation happens under a Redis lock: the replica that takes it generates
 * and stores, and the others wait for the settings invalidation to carry the
 * value to them. A holder that dies leaves a lock that expires, and the next
 * boot tries again.
 */
export const loadOrCreateSigningKeys = async ({
  settings,
  redis,
  logger,
  waitTimeoutMs = WAIT_TIMEOUT_MS,
  waitIntervalMs = WAIT_INTERVAL_MS,
}: LoadSigningKeysOptions): Promise<SigningKeys> => {
  const existing = await settings.get(SIGNING_KEY_SETTING);
  if (existing !== '') {
    return importStored(parseStored(existing));
  }

  const acquired = await redis.set(SIGNING_KEY_LOCK, randomUUID(), 'EX', LOCK_SECONDS, 'NX');
  if (acquired === null) {
    return waitForAnotherReplica({ settings, waitTimeoutMs, waitIntervalMs });
  }

  try {
    // Between the read above and the lock there is room for another replica to
    // have finished, so the setting is read again before anything is written.
    const raced = await settings.get(SIGNING_KEY_SETTING);
    if (raced !== '') {
      return importStored(parseStored(raced));
    }

    const generated = await generate();
    await settings.set(SIGNING_KEY_SETTING, JSON.stringify(generated), { updatedBy: 'system' });
    logger.info(
      { kid: generated.kid },
      'Generated the install signing key pair for access tokens; every replica shares it.',
    );

    return importStored(generated);
  } finally {
    await redis.del(SIGNING_KEY_LOCK);
  }
};

const waitForAnotherReplica = async ({
  settings,
  waitTimeoutMs,
  waitIntervalMs,
}: {
  settings: Settings;
  waitTimeoutMs: number;
  waitIntervalMs: number;
}): Promise<SigningKeys> => {
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    await sleep(waitIntervalMs);
    const value = await settings.get(SIGNING_KEY_SETTING);
    if (value !== '') {
      return importStored(parseStored(value));
    }
  }

  throw new SigningKeyError(
    'Another replica holds the signing-key lock but never stored a key; check the settings table and Redis',
  );
};
