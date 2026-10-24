import { describe, expect, it } from 'vitest';
import { totpRotationConfirmRequestSchema, totpRotationProofSchema } from './totp-rotation.js';

/**
 * The proof is the security property of the rotation (#373), so the shapes it
 * may take are pinned at the boundary: exactly one of the four, and no shape
 * that would let a bare session or a bare password through.
 */

const passkey = {
  ceremonyId: 'A'.repeat(43),
  response: {
    id: 'AQID',
    rawId: 'AQID',
    type: 'public-key' as const,
    response: {
      clientDataJSON: 'e30',
      authenticatorData: 'e30',
      signature: 'e30',
    },
    clientExtensionResults: {},
  },
};

describe('the rotation proof', () => {
  it('takes a live code from the current app', () => {
    expect(totpRotationProofSchema.safeParse({ code: '482913' }).success).toBe(true);
  });

  it('takes a recovery code on its own', () => {
    expect(totpRotationProofSchema.safeParse({ recoveryCode: 'RC-4KQ2-9XMT' }).success).toBe(true);
  });

  it('takes the password with a recovery code', () => {
    expect(
      totpRotationProofSchema.safeParse({
        currentPassword: 'correct horse battery',
        recoveryCode: 'RC-4KQ2-9XMT',
      }).success,
    ).toBe(true);
  });

  it('takes a passkey assertion', () => {
    expect(totpRotationProofSchema.safeParse({ passkey }).success).toBe(true);
  });

  it('refuses a bare password, which alone proves nothing new', () => {
    expect(totpRotationProofSchema.safeParse({ currentPassword: 'correct horse' }).success).toBe(
      false,
    );
  });

  it('refuses two proofs at once', () => {
    expect(
      totpRotationProofSchema.safeParse({ code: '482913', recoveryCode: 'RC-4KQ2-9XMT' }).success,
    ).toBe(false);
    expect(totpRotationProofSchema.safeParse({ code: '482913', passkey }).success).toBe(false);
    expect(
      totpRotationProofSchema.safeParse({ passkey, recoveryCode: 'RC-4KQ2-9XMT' }).success,
    ).toBe(false);
  });

  it('refuses a password beside a code or a passkey, and any field it does not know', () => {
    expect(
      totpRotationProofSchema.safeParse({ code: '482913', currentPassword: 'correct horse' })
        .success,
    ).toBe(false);
    expect(
      totpRotationProofSchema.safeParse({ passkey, currentPassword: 'correct horse' }).success,
    ).toBe(false);
    expect(totpRotationProofSchema.safeParse({ code: '482913', extra: true }).success).toBe(false);
  });

  it('refuses an empty proof and a code with letters', () => {
    expect(totpRotationProofSchema.safeParse({}).success).toBe(false);
    expect(totpRotationProofSchema.safeParse({ code: '4829ab' }).success).toBe(false);
  });
});

describe('the rotation confirmation', () => {
  it('names the staged rotation and the new code', () => {
    expect(
      totpRotationConfirmRequestSchema.safeParse({
        rotationId: '0192c3f0-1a2b-7c3d-8e4f-0000000000aa',
        code: '482913',
      }).success,
    ).toBe(true);
  });

  it('refuses a rotation id that is not a UUID', () => {
    expect(
      totpRotationConfirmRequestSchema.safeParse({ rotationId: 'staged', code: '482913' }).success,
    ).toBe(false);
  });
});
