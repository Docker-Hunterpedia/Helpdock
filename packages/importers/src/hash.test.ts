import { expect, it } from 'vitest';
import { hashImportValue } from './hash.js';

it('makes repeated vendor payloads idempotent despite nested property ordering', () => {
  expect(hashImportValue({ ticket: '42', custom: { a: 1, b: 2 } })).toBe(
    hashImportValue({ custom: { b: 2, a: 1 }, ticket: '42' }),
  );
  expect(hashImportValue({ replies: ['first', 'second'] })).not.toBe(
    hashImportValue({ replies: ['second', 'first'] }),
  );
});
it('rejects non-JSON cursor or payload values instead of silently dropping them', () => {
  expect(() => hashImportValue({ credential: undefined })).toThrow();
});
