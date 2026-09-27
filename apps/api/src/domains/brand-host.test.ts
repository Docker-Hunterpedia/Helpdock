import type { Db } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { BrandHostResolver, type HelpcenterHost, normaliseHost } from './brand-host.js';

const HOST: HelpcenterHost = {
  brandId: '01924f00-0000-7000-8000-0000000000aa',
  domainId: '01924f00-0000-7000-8000-0000000000d1',
  domain: 'help.acme.com',
  cloudflareProxied: false,
  primaryDomain: 'support.acme.com',
};

describe('normaliseHost', () => {
  it('drops the port, the case and the trailing dot', () => {
    expect(normaliseHost('HELP.Acme.com.:443')).toBe('help.acme.com');
    expect(normaliseHost('help.acme.com')).toBe('help.acme.com');
  });

  it.each([undefined, '', 'localhost:3000', '[::1]:3000', '10.0.0.3:3000', 'bad host.example'])(
    'ignores %j, which no stored help center host can match',
    (host) => {
      expect(normaliseHost(host)).toBeUndefined();
    },
  );
});

describe('BrandHostResolver', () => {
  const resolver = (
    lookup: (domain: string) => Promise<HelpcenterHost | undefined>,
    now: () => number = () => 0,
  ) =>
    new BrandHostResolver({
      db: {} as Db,
      lookup,
      ownHosts: ['admin.helpdock.example'],
      ttlMs: 1_000,
      maxEntries: 2,
      now,
    });

  it('maps a verified help center host to its brand, for the request middleware', async () => {
    const lookup = vi.fn(async () => HOST);

    await expect(resolver(lookup).resolve('help.acme.com:443')).resolves.toEqual({
      brandId: HOST.brandId,
      kind: 'helpcenter',
    });
    expect(lookup).toHaveBeenCalledWith('help.acme.com');
  });

  it('gives the help center the primary host with the brand', async () => {
    await expect(
      resolver(async () => HOST).resolveHelpcenter('help.acme.com'),
    ).resolves.toMatchObject({ primaryDomain: 'support.acme.com' });
  });

  it('resolves an unknown host to nothing', async () => {
    await expect(resolver(async () => undefined).resolve('nope.example.com')).resolves.toBeNull();
  });

  it('never looks up the install’s own hosts or a malformed one', async () => {
    const lookup = vi.fn(async () => HOST);
    const hosts = resolver(lookup);

    await expect(hosts.resolve('admin.helpdock.example')).resolves.toBeNull();
    await expect(hosts.resolve('localhost:3000')).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reuses an answer, found or not, until it expires', async () => {
    let clock = 0;
    const lookup = vi.fn(async (domain: string) => (domain === 'help.acme.com' ? HOST : undefined));
    const hosts = resolver(lookup, () => clock);

    await hosts.resolve('help.acme.com');
    await hosts.resolve('nope.example.com');
    await hosts.resolve('help.acme.com');
    await hosts.resolve('nope.example.com');
    expect(lookup).toHaveBeenCalledTimes(2);

    clock = 1_000;
    await hosts.resolve('help.acme.com');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('forgets the oldest host first when it is full', async () => {
    const lookup = vi.fn(async () => undefined);
    const hosts = resolver(lookup);

    await hosts.resolve('a.example.com');
    await hosts.resolve('b.example.com');
    await hosts.resolve('c.example.com');
    await hosts.resolve('b.example.com');
    expect(lookup).toHaveBeenCalledTimes(3);

    await hosts.resolve('a.example.com');
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});
