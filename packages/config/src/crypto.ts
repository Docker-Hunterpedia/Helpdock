import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { decodeMasterKey, type Env } from './env.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_LENGTH = 8;

/** One master key and the id stored alongside every value encrypted under it. */
export interface KeyringEntry {
  readonly id: string;
  readonly key: Buffer;
}

/**
 * The keys a process can decrypt with. Only `current` encrypts; `previous` is
 * the key being rotated away from, so both generations stay readable until every
 * row has been re-encrypted (DOMAIN-RULES §10).
 */
export interface Keyring {
  readonly current: KeyringEntry;
  readonly previous?: KeyringEntry;
}

/** Thrown when key material is not a usable 32-byte master key. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/**
 * Thrown when a stored secret cannot be read back: a malformed envelope, a key
 * id no key in the keyring matches, or a failed authentication tag. The message
 * never contains the value or any key material.
 */
export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

const toEntry = (value: string, label: string): KeyringEntry => {
  const key = decodeMasterKey(value);
  if (key === undefined) {
    throw new MasterKeyError(`${label} must be 32 bytes of standard base64`);
  }

  return Object.freeze({
    id: createHash('sha256').update(key).digest('hex').slice(0, KEY_ID_LENGTH),
    key,
  });
};

/** Builds the keyring from the validated bootstrap environment. */
export const createKeyring = (
  env: Pick<Env, 'APP_MASTER_KEY' | 'APP_MASTER_KEY_PREVIOUS'>,
): Keyring => {
  const current = toEntry(env.APP_MASTER_KEY, 'APP_MASTER_KEY');
  if (env.APP_MASTER_KEY_PREVIOUS === undefined) {
    return Object.freeze({ current });
  }

  return Object.freeze({
    current,
    previous: toEntry(env.APP_MASTER_KEY_PREVIOUS, 'APP_MASTER_KEY_PREVIOUS'),
  });
};

interface Envelope {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

const splitEnvelope = (value: string): Envelope | undefined => {
  const [version, keyId, iv, ciphertext, tag, ...rest] = value.split('.');
  if (version !== VERSION || rest.length > 0) {
    return undefined;
  }
  if (keyId === undefined || iv === undefined || ciphertext === undefined || tag === undefined) {
    return undefined;
  }

  return { keyId, iv, ciphertext, tag };
};

// The version and key id are authenticated as additional data, so swapping the
// header of one stored value onto the body of another fails the tag check
// instead of decrypting under the wrong key.
const associatedData = (keyId: string): Buffer => Buffer.from(`${VERSION}.${keyId}`, 'utf8');

const findKey = (keyring: Keyring, keyId: string): KeyringEntry | undefined => {
  if (keyring.current.id === keyId) {
    return keyring.current;
  }
  return keyring.previous?.id === keyId ? keyring.previous : undefined;
};

/**
 * Encrypts a secret under the current master key and returns the compact
 * envelope stored in the `settings` table:
 * `v1.<keyId>.<iv>.<ciphertext>.<tag>`, the three payloads base64url-encoded.
 */
export const encryptSecret = (plaintext: string, keyring: Keyring): string => {
  const { id, key } = keyring.current;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(id));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    VERSION,
    id,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
};

/** Reverses {@link encryptSecret}, accepting the previous key as well as the current one. */
export const decryptSecret = (value: string, keyring: Keyring): string => {
  const envelope = splitEnvelope(value);
  if (envelope === undefined) {
    throw new SecretDecryptionError('value is not a v1 secret envelope');
  }

  const entry = findKey(keyring, envelope.keyId);
  if (entry === undefined) {
    throw new SecretDecryptionError(`no master key in the keyring has key id ${envelope.keyId}`);
  }

  const iv = Buffer.from(envelope.iv, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new SecretDecryptionError('secret envelope has a malformed iv or authentication tag');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, entry.key, iv);
    decipher.setAAD(associatedData(envelope.keyId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretDecryptionError(
      'secret failed authentication: it was altered or encrypted under a different key',
    );
  }
};

/**
 * Returns the value re-encrypted under the current key, or unchanged when it
 * already is. The key-rotation procedure in DOMAIN-RULES §10 walks every secret
 * row through this.
 */
export const rotateSecret = (value: string, keyring: Keyring): string => {
  const envelope = splitEnvelope(value);
  if (envelope === undefined) {
    throw new SecretDecryptionError('value is not a v1 secret envelope');
  }

  return envelope.keyId === keyring.current.id
    ? value
    : encryptSecret(decryptSecret(value, keyring), keyring);
};
