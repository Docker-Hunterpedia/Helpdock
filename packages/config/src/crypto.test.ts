import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createKeyring,
  decryptSecret,
  encryptSecret,
  MasterKeyError,
  rotateSecret,
  SecretDecryptionError,
} from './crypto.js';

const CURRENT = Buffer.alloc(32, 1).toString('base64');
const PREVIOUS = Buffer.alloc(32, 2).toString('base64');
const OTHER = Buffer.alloc(32, 3).toString('base64');

const currentOnly = createKeyring({ APP_MASTER_KEY: CURRENT });
const rotating = createKeyring({ APP_MASTER_KEY: CURRENT, APP_MASTER_KEY_PREVIOUS: PREVIOUS });
const previousOnly = createKeyring({ APP_MASTER_KEY: PREVIOUS });
const unrelated = createKeyring({ APP_MASTER_KEY: OTHER });

const parts = (envelope: string): string[] => envelope.split('.');

const part = (envelope: string, index: number): string => parts(envelope)[index] ?? '';

const flipFirstByte = (value: string): string => {
  const bytes = Buffer.from(value, 'base64url');
  bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
  return bytes.toString('base64url');
};

const withPart = (envelope: string, index: number, replacement: string): string => {
  const segments = parts(envelope);
  segments[index] = replacement;
  return segments.join('.');
};

describe('createKeyring', () => {
  it('derives the key id from the first 8 hex characters of sha256(key)', () => {
    const expected = createHash('sha256')
      .update(Buffer.from(CURRENT, 'base64'))
      .digest('hex')
      .slice(0, 8);

    expect(currentOnly.current.id).toBe(expected);
    expect(currentOnly.previous).toBeUndefined();
    expect(rotating.previous?.id).toBe(previousOnly.current.id);
  });

  it('rejects key material that is not 32 bytes of base64', () => {
    expect(() => createKeyring({ APP_MASTER_KEY: 'too-short' })).toThrow(MasterKeyError);
    expect(() =>
      createKeyring({ APP_MASTER_KEY: CURRENT, APP_MASTER_KEY_PREVIOUS: 'rubbish' }),
    ).toThrow(/APP_MASTER_KEY_PREVIOUS/);
  });
});

describe('encryptSecret', () => {
  it('produces the documented envelope', () => {
    const envelope = encryptSecret('hunter2', currentOnly);

    expect(parts(envelope)).toHaveLength(5);
    expect(part(envelope, 0)).toBe('v1');
    expect(part(envelope, 1)).toBe(currentOnly.current.id);
    expect(Buffer.from(part(envelope, 2), 'base64url')).toHaveLength(12);
    expect(Buffer.from(part(envelope, 4), 'base64url')).toHaveLength(16);
    expect(part(envelope, 3)).not.toContain('hunter2');
  });

  it('uses a fresh iv for every call, so the same secret never encrypts twice the same', () => {
    const first = encryptSecret('hunter2', currentOnly);
    const second = encryptSecret('hunter2', currentOnly);

    expect(first).not.toBe(second);
    expect(part(first, 2)).not.toBe(part(second, 2));
  });

  it('round-trips every kind of text a setting can hold', () => {
    for (const plaintext of ['', 'hunter2', 'كلمة السر', '{"json":true}', 'a'.repeat(4096)]) {
      expect(decryptSecret(encryptSecret(plaintext, currentOnly), currentOnly)).toBe(plaintext);
    }
  });
});

describe('decryptSecret', () => {
  it('reads a value written under the previous key, so rotation has no downtime', () => {
    const written = encryptSecret('hunter2', previousOnly);

    expect(decryptSecret(written, rotating)).toBe('hunter2');
    expect(() => decryptSecret(written, currentOnly)).toThrow(SecretDecryptionError);
  });

  it('refuses a value encrypted under a key the process does not have', () => {
    const written = encryptSecret('hunter2', unrelated);

    expect(() => decryptSecret(written, rotating)).toThrow(/no master key/);
  });

  it('detects a flipped byte in the ciphertext', () => {
    const envelope = encryptSecret('hunter2', currentOnly);
    const tampered = withPart(envelope, 3, flipFirstByte(part(envelope, 3)));

    expect(() => decryptSecret(tampered, currentOnly)).toThrow(/failed authentication/);
  });

  it('detects a flipped byte in the authentication tag', () => {
    const envelope = encryptSecret('hunter2', currentOnly);
    const tampered = withPart(envelope, 4, flipFirstByte(part(envelope, 4)));

    expect(() => decryptSecret(tampered, currentOnly)).toThrow(/failed authentication/);
  });

  it('detects a key id swapped onto another key generation', () => {
    const envelope = encryptSecret('hunter2', previousOnly);
    const relabelled = withPart(envelope, 1, rotating.current.id);

    expect(() => decryptSecret(relabelled, rotating)).toThrow(/failed authentication/);
  });

  it('rejects a malformed envelope', () => {
    const envelope = encryptSecret('hunter2', currentOnly);

    for (const malformed of [
      '',
      'hunter2',
      'v1',
      'v1.deadbeef.aa',
      envelope.slice(envelope.indexOf('.') + 1),
      `${envelope}.extra`,
      withPart(envelope, 0, 'v2'),
      withPart(envelope, 2, Buffer.alloc(8).toString('base64url')),
      withPart(envelope, 4, Buffer.alloc(8).toString('base64url')),
    ]) {
      expect(() => decryptSecret(malformed, currentOnly), malformed).toThrow(SecretDecryptionError);
    }
  });
});

describe('rotateSecret', () => {
  it('re-encrypts a value that is still under the previous key', () => {
    const written = encryptSecret('hunter2', previousOnly);
    const rotated = rotateSecret(written, rotating);

    expect(part(rotated, 1)).toBe(rotating.current.id);
    expect(decryptSecret(rotated, currentOnly)).toBe('hunter2');
  });

  it('leaves a value that is already under the current key untouched', () => {
    const written = encryptSecret('hunter2', rotating);

    expect(rotateSecret(written, rotating)).toBe(written);
  });

  it('rejects a malformed envelope rather than replacing it', () => {
    expect(() => rotateSecret('not-an-envelope', rotating)).toThrow(SecretDecryptionError);
  });
});
