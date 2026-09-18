import { describe, expect, it } from 'vitest';
import { asRedirectBlocked, SafeFetchError } from './errors.js';

describe('SafeFetchError', () => {
  it('carries the destination so a blocked attempt can be logged', () => {
    const error = new SafeFetchError('destination-blocked', 'blocked', {
      url: 'http://internal.test/',
      host: 'internal.test',
      address: '10.0.0.1',
      hop: 2,
    });

    expect(error.name).toBe('SafeFetchError');
    expect(error.code).toBe('destination-blocked');
    expect(error.host).toBe('internal.test');
    expect(error.address).toBe('10.0.0.1');
    expect(error.hop).toBe(2);
    expect(error.reason).toBeUndefined();
  });

  it('defaults to the first hop when no details are given', () => {
    const error = new SafeFetchError('invalid-url', 'bad');

    expect(error.hop).toBe(0);
    expect(error.url).toBeUndefined();
  });
});

describe('asRedirectBlocked', () => {
  it('re-labels a hop failure without losing the original reason', () => {
    const original = new SafeFetchError('destination-blocked', 'resolves to 10.0.0.1', {
      url: 'http://internal.test/',
      host: 'internal.test',
      address: '10.0.0.1',
      hop: 3,
    });

    const wrapped = asRedirectBlocked(original);

    expect(wrapped.code).toBe('redirect-blocked');
    expect(wrapped.reason).toBe('destination-blocked');
    expect(wrapped.hop).toBe(3);
    expect(wrapped.address).toBe('10.0.0.1');
    expect(wrapped.message).toContain('redirect hop 3 blocked');
    expect(wrapped.cause).toBe(original);
  });
});
