import { describe, expect, it } from 'vitest';
import { anonymisedEmail } from './anonymise.js';

const ALICE = '0199f4b2-6a91-7c27-9a1f-00000000000a';
const BOB = '0199f4b2-6a91-7c27-9a1f-00000000000b';

describe('anonymisedEmail', () => {
  it('is stable for one account, so a second delete is idempotent', () => {
    expect(anonymisedEmail(ALICE)).toBe(anonymisedEmail(ALICE));
  });

  it('differs per account, so the unique index on lower(email) still holds', () => {
    expect(anonymisedEmail(ALICE)).not.toBe(anonymisedEmail(BOB));
  });

  it('carries nothing of the address it replaced', () => {
    expect(anonymisedEmail(ALICE)).not.toContain(ALICE);
    expect(anonymisedEmail(ALICE)).toMatch(/^former-staff\+[0-9a-f]{32}@deleted\.invalid$/);
  });
});
