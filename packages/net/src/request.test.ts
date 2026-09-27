import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import { toResponseHeaders } from './request.js';

describe('toResponseHeaders', () => {
  it('keeps a remote __proto__ header as an own entry without touching any prototype', () => {
    // JSON.parse is the one way to build an object whose own key is `__proto__`,
    // which is the shape Node hands over for a server that sends that header.
    const remote: IncomingHttpHeaders = JSON.parse(
      '{"__proto__": "polluted", "content-type": "text/plain"}',
    );

    const headers = toResponseHeaders(remote);

    expect(Object.entries(headers)).toEqual([
      ['__proto__', 'polluted'],
      ['content-type', 'text/plain'],
    ]);
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('drops headers that carry no value', () => {
    expect(toResponseHeaders({ 'set-cookie': ['a=1'], etag: undefined })).toEqual({
      'set-cookie': ['a=1'],
    });
  });
});
