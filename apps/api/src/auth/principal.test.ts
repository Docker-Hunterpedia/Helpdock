import { describe, expect, it } from 'vitest';
import { auditActorTypeOf, brandsOf, type Principal, principalIdOf } from './principal.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const ID = '01937f5e-7e53-7000-8000-000000000001';

const principals: Record<'staff' | 'visitor' | 'apikey' | 'system', Principal> = {
  staff: {
    type: 'staff',
    id: ID,
    brands: { [BRAND]: { role: 'agent', departmentIds: 'all' } },
    installAdmin: false,
  },
  visitor: { type: 'visitor', id: ID, brandId: BRAND, conversationIds: [] },
  apikey: { type: 'apikey', id: ID, brandId: BRAND, scopes: [] },
  system: { type: 'system', brandId: BRAND, jobId: 'job:1' },
};
const customer: Principal = { type: 'customer', id: ID, brandId: BRAND, sees: 'own' };

describe('auditActorTypeOf', () => {
  it.each(Object.entries(principals))('records a %s as itself', (type, principal) => {
    expect(auditActorTypeOf(principal)).toBe(type);
  });

  it('refuses a customer: a portal visitor is never an audit actor', () => {
    expect(() => auditActorTypeOf(customer)).toThrow(/not an audit actor/);
  });
});

describe('the customer principal', () => {
  it('reaches exactly the brand of its session and is named by its contact', () => {
    expect(brandsOf(customer)).toEqual([BRAND]);
    expect(principalIdOf(customer)).toBe(ID);
  });
});
