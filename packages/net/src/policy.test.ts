import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  policies,
  reportBlocked,
  resolvePolicy,
} from './policy.js';

describe('resolvePolicy', () => {
  it('fills in the defaults from DOMAIN-RULES §13', () => {
    const resolved = resolvePolicy();

    expect([...resolved.allowedPorts]).toEqual([...DEFAULT_ALLOWED_PORTS]);
    expect(resolved.maxRedirects).toBe(DEFAULT_MAX_REDIRECTS);
    expect(resolved.connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
    expect(resolved.totalTimeoutMs).toBe(DEFAULT_TOTAL_TIMEOUT_MS);
    expect(resolved.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(resolved.allowCidrs).toEqual([]);
    expect(resolved.onBlocked).toBeUndefined();
  });

  it('keeps the caller overrides', () => {
    const onBlocked = vi.fn();
    const resolved = resolvePolicy({
      allowedPorts: [8443],
      maxRedirects: 0,
      connectTimeoutMs: 1,
      totalTimeoutMs: 2,
      maxBodyBytes: 3,
      onBlocked,
    });

    expect([...resolved.allowedPorts]).toEqual([8443]);
    expect(resolved.maxRedirects).toBe(0);
    expect(resolved.connectTimeoutMs).toBe(1);
    expect(resolved.totalTimeoutMs).toBe(2);
    expect(resolved.maxBodyBytes).toBe(3);
    expect(resolved.onBlocked).toBe(onBlocked);
  });

  it('parses every allow-list entry', () => {
    const resolved = resolvePolicy({ allowCidrs: ['10.0.0.0/8', 'fd00::/8'] });
    expect(resolved.allowCidrs).toHaveLength(2);
    expect(resolved.allowCidrs[0]?.prefix).toBe(8);
  });

  it('rejects a mistyped allow-list entry rather than dropping it', () => {
    expect(() => resolvePolicy({ allowCidrs: ['10.0.0.0/8', '10.0.0.999/8'] })).toThrow(
      /invalid CIDR in allowCidrs: 10\.0\.0\.999\/8/,
    );
  });

  it.each([
    [{ connectTimeoutMs: 0 }, /connectTimeoutMs/],
    [{ totalTimeoutMs: -1 }, /totalTimeoutMs/],
    [{ maxBodyBytes: Number.NaN }, /maxBodyBytes/],
    [{ maxRedirects: -1 }, /maxRedirects/],
    [{ maxRedirects: 1.5 }, /maxRedirects/],
  ])('rejects a nonsensical budget %o', (policy, message) => {
    expect(() => resolvePolicy(policy)).toThrow(message);
  });
});

describe('policies presets', () => {
  // Resolved rather than read field by field, so a preset whose key is misspelled
  // fails here instead of silently falling back to the default cap.
  it.each([
    ['crawl', 10 * 1024 * 1024, DEFAULT_TOTAL_TIMEOUT_MS],
    ['webhook', 1024 * 1024, 15_000],
    ['imageProxy', 20 * 1024 * 1024, DEFAULT_TOTAL_TIMEOUT_MS],
  ] as const)('applies the %s caps from DOMAIN-RULES §13', (name, maxBodyBytes, totalTimeoutMs) => {
    const resolved = resolvePolicy(policies[name]);

    expect(resolved.maxBodyBytes).toBe(maxBodyBytes);
    expect(resolved.totalTimeoutMs).toBe(totalTimeoutMs);
  });
});

describe('reportBlocked', () => {
  const event = {
    code: 'destination-blocked',
    url: 'http://internal.test/',
    host: 'internal.test',
    address: '10.0.0.1',
    hop: 0,
    reason: 'blocked',
  } as const;

  it('passes the event to the hook', () => {
    const onBlocked = vi.fn();
    reportBlocked(resolvePolicy({ onBlocked }), event);
    expect(onBlocked).toHaveBeenCalledWith(event);
  });

  it('does nothing when there is no hook', () => {
    expect(() => {
      reportBlocked(resolvePolicy(), event);
    }).not.toThrow();
  });

  it('swallows a hook that throws, so a broken logger cannot mask a block', () => {
    const onBlocked = vi.fn(() => {
      throw new Error('logger is down');
    });

    expect(() => {
      reportBlocked(resolvePolicy({ onBlocked }), event);
    }).not.toThrow();
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });
});
