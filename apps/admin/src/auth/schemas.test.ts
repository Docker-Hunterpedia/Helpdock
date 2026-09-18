import { describe, expect, it } from 'vitest';
import { MOCK_BRANDS } from './mock-api.js';
import { sessionSchema, signInResultSchema } from './schemas.js';

const session = {
  user: {
    id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a',
    name: 'Lina Haddad',
    email: 'lina@helpdock.com',
    role: 'admin',
    installAdmin: true,
  },
  brands: MOCK_BRANDS,
  currentBrandId: MOCK_BRANDS[0]?.id,
};

describe('sessionSchema', () => {
  it('accepts the shape the mock produces, so the contract and the fixture agree', () => {
    expect(sessionSchema.parse(session)).toMatchObject({ currentBrandId: MOCK_BRANDS[0]?.id });
  });

  it('refuses a session with no brand, because every screen is brand-scoped', () => {
    expect(sessionSchema.safeParse({ ...session, brands: [] }).success).toBe(false);
  });

  it('refuses a role outside the four in DOMAIN-RULES §1.1', () => {
    const owner = { ...session, user: { ...session.user, role: 'owner' } };

    expect(sessionSchema.safeParse(owner).success).toBe(false);
  });
});

describe('signInResultSchema', () => {
  it('tells a finished sign-in from one that still needs a code', () => {
    const challenge = signInResultSchema.parse({
      kind: 'totp-required',
      challengeId: 'c1',
      email: 'lina@helpdock.com',
    });

    expect(challenge.kind).toBe('totp-required');
    expect(signInResultSchema.safeParse({ kind: 'totp-required', challengeId: '' }).success).toBe(
      false,
    );
  });
});
