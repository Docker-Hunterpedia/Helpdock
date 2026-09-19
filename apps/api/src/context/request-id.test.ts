import { isUuid } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { isUsableRequestId, resolveRequestId } from './request-id.js';

describe('resolveRequestId', () => {
  it('generates a time-ordered id when no proxy is trusted', () => {
    const id = resolveRequestId('from-the-client', { trustProxy: false });

    expect(isUuid(id)).toBe(true);
    expect(id).not.toBe('from-the-client');
  });

  it('generates ids that sort in the order they were drawn', () => {
    const ids = Array.from({ length: 50 }, () =>
      resolveRequestId(undefined, { trustProxy: false }),
    );

    expect([...ids].sort()).toEqual(ids);
  });

  it('honours the proxy header when the proxy is trusted', () => {
    expect(resolveRequestId('caddy-01HZX', { trustProxy: true })).toBe('caddy-01HZX');
  });

  it('trims a trusted header', () => {
    expect(resolveRequestId('  spaced  ', { trustProxy: true })).toBe('spaced');
  });

  it.each([
    ['a newline, which would forge a log line', 'abc\ndef'],
    ['a quote, which would end a JSON string', 'abc"def'],
    ['a space', 'abc def'],
    ['nothing at all', ''],
    ['more than 128 characters', 'a'.repeat(129)],
  ])('refuses %s and generates instead', (_reason, value) => {
    const id = resolveRequestId(value, { trustProxy: true });

    expect(isUuid(id)).toBe(true);
  });

  it('refuses a duplicated header rather than picking one of the values', () => {
    const id = resolveRequestId(['first', 'second'], { trustProxy: true });

    expect(isUuid(id)).toBe(true);
  });
});

describe('isUsableRequestId', () => {
  it('accepts the shapes a proxy or a tracer produces', () => {
    for (const value of [
      '0199f4b2-6a91-7c27-9a1f-6f2f1d0a0b33',
      '4bf92f3577b34da6a3ce929d0e0e4736',
      'caddy.req:12_34-56',
      'a'.repeat(128),
    ]) {
      expect(isUsableRequestId(value), value).toBe(true);
    }
  });
});
