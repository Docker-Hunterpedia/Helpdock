import { describe, expect, it } from 'vitest';
import { requestHashOf } from './idempotency.interceptor.js';

const request = (body: unknown, url = '/api/v1/tickets') => ({
  method: 'POST',
  url,
  headers: {},
  body,
});

describe('requestHashOf', () => {
  it('is the same for the same method, path and body', () => {
    expect(requestHashOf(request({ subject: 'Refund' }))).toBe(
      requestHashOf(request({ subject: 'Refund' })),
    );
  });

  it('differs when the body or the path does, so a reused key is caught', () => {
    const first = requestHashOf(request({ subject: 'Refund' }));

    expect(requestHashOf(request({ subject: 'Return' }))).not.toBe(first);
    expect(requestHashOf(request({ subject: 'Refund' }, '/api/v1/contacts'))).not.toBe(first);
  });
});
