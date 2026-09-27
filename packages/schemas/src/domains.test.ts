import { describe, expect, it } from 'vitest';
import {
  customDomainCreateRequestSchema,
  customDomainUpdateRequestSchema,
  MAX_DOMAIN_LENGTH,
  txtRecordNameFor,
  txtRecordValueFor,
} from './domains.js';

describe('the TXT record', () => {
  it('lives under _helpdock and carries the token after the prefix', () => {
    expect(txtRecordNameFor('support.acme.com')).toBe('_helpdock.support.acme.com');
    expect(txtRecordValueFor('abc123')).toBe('helpdock-verify=abc123');
  });
});

describe('customDomainCreateRequestSchema', () => {
  it('trims the name and leaves the rest to the api', () => {
    expect(customDomainCreateRequestSchema.parse({ domain: ' Support.Acme.com ' })).toEqual({
      domain: 'Support.Acme.com',
    });
  });

  it('refuses an empty or over-long name', () => {
    expect(customDomainCreateRequestSchema.safeParse({ domain: '  ' }).success).toBe(false);
    expect(
      customDomainCreateRequestSchema.safeParse({ domain: 'a'.repeat(MAX_DOMAIN_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});

describe('customDomainUpdateRequestSchema', () => {
  it('accepts the Cloudflare flag, "make primary", or both', () => {
    expect(customDomainUpdateRequestSchema.safeParse({ cloudflareProxied: false }).success).toBe(
      true,
    );
    expect(customDomainUpdateRequestSchema.safeParse({ primary: true }).success).toBe(true);
  });

  it('refuses an empty body and a request to clear primary', () => {
    expect(customDomainUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(customDomainUpdateRequestSchema.safeParse({ primary: false }).success).toBe(false);
  });
});
