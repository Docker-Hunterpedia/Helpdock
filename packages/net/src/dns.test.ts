import { describe, expect, it } from 'vitest';
import { createDnsResolver, type DnsBackend, MAX_DNS_RECORDS, MAX_TXT_LENGTH } from './dns.js';

const failure = (code: string): Error => Object.assign(new Error(code), { code });

const backend = (overrides: Partial<DnsBackend>): DnsBackend => ({
  resolveCname: () => Promise.reject(failure('ENODATA')),
  resolveTxt: () => Promise.reject(failure('ENODATA')),
  resolve4: () => Promise.reject(failure('ENODATA')),
  resolve6: () => Promise.reject(failure('ENODATA')),
  ...overrides,
});

describe('createDnsResolver', () => {
  it('normalises CNAME targets', async () => {
    const dns = createDnsResolver({
      backend: backend({ resolveCname: () => Promise.resolve(['Edge.Helpdock.IO.']) }),
    });

    await expect(dns.cname('support.acme.com')).resolves.toEqual({
      status: 'found',
      records: ['edge.helpdock.io'],
    });
  });

  it('joins the character strings of a TXT record and caps its length', async () => {
    const dns = createDnsResolver({
      backend: backend({
        resolveTxt: () =>
          Promise.resolve([['helpdock-verify=', 'abc'], ['x'.repeat(MAX_TXT_LENGTH + 10)]]),
      }),
    });

    const answer = await dns.txt('_helpdock.support.acme.com');

    expect(answer.status).toBe('found');
    const records = answer.status === 'found' ? answer.records : [];
    expect(records[0]).toBe('helpdock-verify=abc');
    expect(records[1]).toHaveLength(MAX_TXT_LENGTH);
  });

  it('keeps at most the record cap', async () => {
    const many = Array.from({ length: MAX_DNS_RECORDS + 5 }, (_, index) => `10.0.0.${index}`);
    const dns = createDnsResolver({ backend: backend({ resolve4: () => Promise.resolve(many) }) });

    const answer = await dns.addresses('support.acme.com');

    expect(answer.status === 'found' ? answer.records : []).toHaveLength(MAX_DNS_RECORDS);
  });

  it.each(['ENOTFOUND', 'ENODATA'])('reads %s as a record that is absent', async (code) => {
    const dns = createDnsResolver({
      backend: backend({ resolveCname: () => Promise.reject(failure(code)) }),
    });

    await expect(dns.cname('support.acme.com')).resolves.toEqual({ status: 'absent' });
  });

  it('reads a timeout as a failed lookup, never as an absent record', async () => {
    const dns = createDnsResolver({
      backend: backend({ resolveTxt: () => Promise.reject(failure('ETIMEOUT')) }),
    });

    await expect(dns.txt('support.acme.com')).resolves.toEqual({
      status: 'failed',
      code: 'ETIMEOUT',
    });
  });

  it('names an error without a code as unknown', async () => {
    const dns = createDnsResolver({
      backend: backend({ resolveTxt: () => Promise.reject(new Error('boom')) }),
    });

    await expect(dns.txt('support.acme.com')).resolves.toEqual({
      status: 'failed',
      code: 'EUNKNOWN',
    });
  });

  it('treats an empty answer as absent', async () => {
    const dns = createDnsResolver({
      backend: backend({ resolveCname: () => Promise.resolve([]) }),
    });

    await expect(dns.cname('support.acme.com')).resolves.toEqual({ status: 'absent' });
  });

  describe('addresses', () => {
    it('merges A and AAAA answers', async () => {
      const dns = createDnsResolver({
        backend: backend({
          resolve4: () => Promise.resolve(['93.184.216.34']),
          resolve6: () => Promise.resolve(['2606:2800:220:1::']),
        }),
      });

      await expect(dns.addresses('support.acme.com')).resolves.toEqual({
        status: 'found',
        records: ['93.184.216.34', '2606:2800:220:1::'],
      });
    });

    it('is found when one family answers and the other fails', async () => {
      const dns = createDnsResolver({
        backend: backend({
          resolve4: () => Promise.resolve(['93.184.216.34']),
          resolve6: () => Promise.reject(failure('ETIMEOUT')),
        }),
      });

      await expect(dns.addresses('support.acme.com')).resolves.toMatchObject({ status: 'found' });
    });

    it('fails when nothing was found and either family failed', async () => {
      const v4 = createDnsResolver({
        backend: backend({ resolve4: () => Promise.reject(failure('ESERVFAIL')) }),
      });
      const v6 = createDnsResolver({
        backend: backend({ resolve6: () => Promise.reject(failure('EREFUSED')) }),
      });

      await expect(v4.addresses('a.acme.com')).resolves.toEqual({
        status: 'failed',
        code: 'ESERVFAIL',
      });
      await expect(v6.addresses('a.acme.com')).resolves.toEqual({
        status: 'failed',
        code: 'EREFUSED',
      });
    });

    it('is absent when both families are absent', async () => {
      const dns = createDnsResolver({ backend: backend({}) });

      await expect(dns.addresses('support.acme.com')).resolves.toEqual({ status: 'absent' });
    });
  });

  it('builds a Node resolver with the configured servers when no backend is given', () => {
    const dns = createDnsResolver({ timeoutMs: 100, tries: 1, servers: ['127.0.0.1'] });

    expect(typeof dns.cname).toBe('function');
  });
});
