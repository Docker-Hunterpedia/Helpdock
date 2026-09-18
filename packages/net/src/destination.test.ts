import { describe, expect, it, vi } from 'vitest';
import { resolveDestination, validateUrl } from './destination.js';
import { SafeFetchError } from './errors.js';
import type { LookupAddress, SafeFetchPolicy } from './policy.js';
import { resolvePolicy } from './policy.js';

function policyWith(overrides: SafeFetchPolicy = {}) {
  return resolvePolicy(overrides);
}

function lookupReturning(...addresses: readonly LookupAddress[]) {
  return vi.fn(async () => addresses);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<SafeFetchError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SafeFetchError);
  expect((error as SafeFetchError).code).toBe(code);
  return error as SafeFetchError;
}

function expectSyncCode(run: () => unknown, code: string): SafeFetchError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SafeFetchError);
    expect((error as SafeFetchError).code).toBe(code);
    return error as SafeFetchError;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe('validateUrl', () => {
  it('accepts http and https on a default port', () => {
    expect(validateUrl('http://example.com/a?b=1', policyWith(), 0).port).toBe(80);
    expect(validateUrl('https://example.com/', policyWith(), 0).port).toBe(443);
  });

  it('strips the brackets a URL puts around an IPv6 literal', () => {
    expect(validateUrl('http://[::1]:8080/', policyWith(), 0).hostname).toBe('::1');
  });

  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com/'])(
    'rejects the scheme in %s',
    (url) => {
      expectSyncCode(() => validateUrl(url, policyWith(), 0), 'scheme-not-allowed');
    },
  );

  it.each(['http://user:pass@example.com/', 'http://user@example.com/'])(
    'rejects credentials in %s',
    (url) => {
      const error = expectSyncCode(() => validateUrl(url, policyWith(), 0), 'credentials-in-url');
      expect(error.message).not.toContain('pass');
    },
  );

  it('rejects a non-standard port', () => {
    const error = expectSyncCode(
      () => validateUrl('http://example.com:9999/', policyWith(), 0),
      'port-not-allowed',
    );
    expect(error.message).toContain('9999');
  });

  it('accepts a non-standard port the policy allows', () => {
    expect(
      validateUrl('http://example.com:9999/', policyWith({ allowedPorts: [9999] }), 0).port,
    ).toBe(9999);
  });

  it.each(['not-a-url', '/relative/path', 'http://'])('rejects the unparseable URL %s', (url) => {
    expectSyncCode(() => validateUrl(url, policyWith(), 0), 'invalid-url');
  });

  it('accepts a URL instance as well as a string', () => {
    expect(validateUrl(new URL('https://example.com/x'), policyWith(), 0).hostname).toBe(
      'example.com',
    );
  });

  it('records the hop it was given', () => {
    const error = expectSyncCode(
      () => validateUrl('ftp://example.com/', policyWith(), 3),
      'scheme-not-allowed',
    );
    expect(error.hop).toBe(3);
  });
});

describe('resolveDestination', () => {
  const target = (url: string, policy = policyWith()) => validateUrl(url, policy, 0);

  it('pins the first resolved address', async () => {
    const policy = policyWith({ lookup: lookupReturning({ address: '93.184.216.34', family: 4 }) });
    const destination = await resolveDestination(target('http://example.com/'), policy, 0);

    expect(destination.address).toBe('93.184.216.34');
    expect(destination.family).toBe(4);
  });

  it('does not resolve a literal address', async () => {
    const lookup = lookupReturning({ address: '10.0.0.1', family: 4 });
    const policy = policyWith({ lookup, allowCidrs: ['203.0.113.0/24'] });

    const destination = await resolveDestination(target('http://203.0.113.9/'), policy, 0);

    expect(destination.address).toBe('203.0.113.9');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('checks a literal address against the blocked ranges', async () => {
    const error = await expectCode(
      resolveDestination(target('http://127.0.0.1/'), policyWith(), 0),
      'destination-blocked',
    );
    expect(error.message).toContain('IPv4 loopback');
  });

  it('rejects when any resolved address is blocked, not only the first', async () => {
    const policy = policyWith({
      lookup: lookupReturning(
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ),
    });

    const error = await expectCode(
      resolveDestination(target('http://example.com/'), policy, 0),
      'destination-blocked',
    );
    expect(error.address).toBe('169.254.169.254');
    expect(error.message).toContain('cloud metadata');
  });

  it('lets the allow-list override a blocked range', async () => {
    const policy = policyWith({
      lookup: lookupReturning({ address: '10.1.2.3', family: 4 }),
      allowCidrs: ['10.0.0.0/8'],
    });

    const destination = await resolveDestination(
      target('http://notion-proxy.internal/'),
      policy,
      0,
    );
    expect(destination.address).toBe('10.1.2.3');
  });

  it('matches the allow-list through an IPv4-mapped IPv6 answer', async () => {
    const policy = policyWith({
      lookup: lookupReturning({ address: '::ffff:10.1.2.3', family: 6 }),
      allowCidrs: ['10.0.0.0/8'],
    });

    const destination = await resolveDestination(
      target('http://notion-proxy.internal/'),
      policy,
      0,
    );
    expect(destination.family).toBe(6);
  });

  it('keeps blocking an address the allow-list does not cover', async () => {
    const policy = policyWith({
      lookup: lookupReturning({ address: '192.168.1.1', family: 4 }),
      allowCidrs: ['10.0.0.0/8'],
    });

    await expectCode(
      resolveDestination(target('http://internal.test/'), policy, 0),
      'destination-blocked',
    );
  });

  it('reports a resolver failure as dns-failure', async () => {
    const policy = policyWith({
      lookup: vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    });

    const error = await expectCode(
      resolveDestination(target('http://nowhere.test/'), policy, 0),
      'dns-failure',
    );
    expect(error.host).toBe('nowhere.test');
  });

  it('reports an empty answer as dns-failure', async () => {
    const policy = policyWith({ lookup: lookupReturning() });
    await expectCode(resolveDestination(target('http://nowhere.test/'), policy, 0), 'dns-failure');
  });

  it.each([
    ['http://2130706433/', 'a decimal integer'],
    ['http://0x7f.1/', 'hexadecimal shorthand'],
    ['http://017700000001/', 'an octal integer'],
    ['http://[::ffff:127.0.0.1]/', 'an IPv4-mapped IPv6 literal'],
  ])('blocks %s, which is loopback written as %s', async (target) => {
    // The WHATWG URL parser normalises these host forms to 127.0.0.1 before the
    // range check ever runs; the check is on the address, never on the spelling.
    const lookup = lookupReturning({ address: '93.184.216.34', family: 4 });
    const policy = policyWith({ lookup });
    const error = await expectCode(
      resolveDestination(validateUrl(target, policy, 0), policy, 0),
      'destination-blocked',
    );

    expect(error.message).toContain('loopback');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('derives the family from the address rather than the resolver label', async () => {
    const policy = policyWith({
      lookup: lookupReturning({ address: '2606:4700:4700::1111', family: 4 }),
    });

    const destination = await resolveDestination(target('http://example.com/', policy), policy, 0);
    expect(destination.family).toBe(6);
  });

  it('refuses an answer it cannot parse as an address', async () => {
    const policy = policyWith({ lookup: lookupReturning({ address: 'localhost', family: 4 }) });
    const error = await expectCode(
      resolveDestination(target('http://nowhere.test/'), policy, 0),
      'destination-blocked',
    );
    expect(error.message).toContain('unparseable');
  });
});
