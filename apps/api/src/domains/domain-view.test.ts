import type { BrandDomain } from '@helpdock/db';
import { customDomainSchema } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { toCustomDomain } from './domain-view.js';

const AT = new Date('2026-09-27T12:00:00Z');

const row = (overrides: Partial<BrandDomain> = {}): BrandDomain => ({
  id: '01924f00-0000-7000-8000-0000000000d1',
  brandId: '01924f00-0000-7000-8000-0000000000aa',
  domain: 'support.acme.com',
  kind: 'helpcenter',
  verifiedAt: null,
  txtToken: 'tok123',
  createdAt: AT,
  isPrimary: false,
  cloudflareProxied: false,
  cnameSeenAt: null,
  txtSeenAt: null,
  tlsIssuedAt: null,
  lastCheckedAt: null,
  checkRequestedAt: null,
  failureReason: null,
  failureDetail: null,
  ...overrides,
});

describe('toCustomDomain', () => {
  it('shows a new domain as pending, with the two records to publish', () => {
    const view = toCustomDomain(row(), 'edge.helpdock.example');

    expect(customDomainSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      state: 'pending',
      tls: null,
      failure: null,
      records: {
        cname: {
          type: 'CNAME',
          name: 'support.acme.com',
          value: 'edge.helpdock.example',
          seen: false,
        },
        txt: {
          type: 'TXT',
          name: '_helpdock.support.acme.com',
          value: 'helpdock-verify=tok123',
          seen: false,
        },
      },
    });
  });

  it('says which records the last check saw', () => {
    const view = toCustomDomain(row({ txtSeenAt: AT }), 'edge.helpdock.example');

    expect(view.records.cname.seen).toBe(false);
    expect(view.records.txt.seen).toBe(true);
  });

  it('distinguishes a certificate issued, one still to come, and Cloudflare serving HTTPS', () => {
    expect(toCustomDomain(row({ verifiedAt: AT, tlsIssuedAt: AT }), 't.example').tls).toBe(
      'issued',
    );
    expect(toCustomDomain(row({ verifiedAt: AT }), 't.example')).toMatchObject({
      state: 'verified',
      tls: 'pending',
    });
    expect(toCustomDomain(row({ verifiedAt: AT, cloudflareProxied: true }), 't.example').tls).toBe(
      'cloudflare',
    );
  });

  it('reports a failure as failed, with its reason, even when DNS is verified', () => {
    const view = toCustomDomain(
      row({ verifiedAt: AT, failureReason: 'certificate_failed', failureDetail: 'timeout' }),
      't.example',
    );

    expect(view).toMatchObject({
      state: 'failed',
      failure: { reason: 'certificate_failed', detail: 'timeout' },
      verifiedAt: AT.toISOString(),
    });
  });
});
