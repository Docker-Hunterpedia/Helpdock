import { describe, expect, it } from 'vitest';
import { principalSchema } from './principal.js';

const BRAND_A = '01937f5e-7e53-7000-8000-00000000000a';
const BRAND_B = '01937f5e-7e53-7000-8000-00000000000b';
const USER = '01937f5e-7e53-7000-8000-000000000001';

describe('principalSchema', () => {
  it('accepts a staff member with one role per brand', () => {
    const parsed = principalSchema.parse({
      type: 'staff',
      id: USER,
      brands: {
        [BRAND_A]: { role: 'admin', departmentIds: 'all' },
        [BRAND_B]: { role: 'agent', departmentIds: [BRAND_B] },
      },
      installAdmin: false,
    });

    expect(parsed).toMatchObject({ type: 'staff', installAdmin: false });
  });

  it('rejects a role outside the four of DOMAIN-RULES §1.2', () => {
    const result = principalSchema.safeParse({
      type: 'staff',
      id: USER,
      brands: { [BRAND_A]: { role: 'owner', departmentIds: 'all' } },
      installAdmin: false,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a brand key that is not a uuid, so it can never reach a session setting', () => {
    const result = principalSchema.safeParse({
      type: 'staff',
      id: USER,
      brands: { "'; drop table brands--": { role: 'admin', departmentIds: 'all' } },
      installAdmin: false,
    });

    expect(result.success).toBe(false);
  });

  it('accepts a visitor with and without a verified contact', () => {
    const base = { type: 'visitor', id: USER, brandId: BRAND_A, conversationIds: [] };

    expect(principalSchema.safeParse(base).success).toBe(true);
    expect(principalSchema.safeParse({ ...base, verifiedContactId: USER }).success).toBe(true);
  });

  it('accepts an api key and a system principal', () => {
    expect(
      principalSchema.safeParse({ type: 'apikey', id: USER, brandId: BRAND_A, scopes: ['x'] })
        .success,
    ).toBe(true);
    expect(
      principalSchema.safeParse({ type: 'system', brandId: BRAND_A, jobId: 'outbox.relay:42' })
        .success,
    ).toBe(true);
  });

  it('rejects an unknown principal type', () => {
    expect(principalSchema.safeParse({ type: 'root', id: USER }).success).toBe(false);
  });

  describe('the customer principal (M21-01)', () => {
    const customer = { type: 'customer', id: USER, brandId: BRAND_A, sees: 'own' };

    it('accepts a customer with and without an account', () => {
      expect(principalSchema.parse(customer)).toEqual(customer);
      expect(principalSchema.parse({ ...customer, accountId: BRAND_B, sees: 'account' })).toEqual({
        ...customer,
        accountId: BRAND_B,
        sees: 'account',
      });
    });

    it('refuses what `sees` cannot say, and ids that are not uuids', () => {
      expect(principalSchema.safeParse({ ...customer, sees: 'everyone' }).success).toBe(false);
      expect(principalSchema.safeParse({ ...customer, sees: undefined }).success).toBe(false);
      expect(principalSchema.safeParse({ ...customer, brandId: 'brand' }).success).toBe(false);
      expect(principalSchema.safeParse({ ...customer, accountId: 'acme' }).success).toBe(false);
    });
  });
});
