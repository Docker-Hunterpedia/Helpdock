import { describe, expect, it } from 'vitest';
import { brandIdParamSchema, brandSchema } from './brand.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';

const row = {
  id: BRAND,
  name: 'Helpdock',
  prefix: 'HD',
  defaultLocale: 'en',
  timezone: 'UTC',
  status: 'active',
};

describe('brandSchema', () => {
  it('drops a column the response must not carry', () => {
    const parsed = brandSchema.parse({ ...row, deletedAt: null, createdAt: new Date() });

    expect(parsed).toEqual(row);
  });

  it('rejects a locale outside en and ar', () => {
    expect(brandSchema.safeParse({ ...row, defaultLocale: 'fr' }).success).toBe(false);
  });
});

describe('brandIdParamSchema', () => {
  it('rejects a path parameter that is not a uuid', () => {
    expect(brandIdParamSchema.safeParse({ brandId: 'not-a-uuid' }).success).toBe(false);
    expect(brandIdParamSchema.safeParse({ brandId: BRAND }).success).toBe(true);
  });
});
