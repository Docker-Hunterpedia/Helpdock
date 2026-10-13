import { expect, it } from 'vitest';
import { isInvalidUtf8 } from './utf8.js';

it('recognizes fatal decoder errors without converting unrelated failures', () => {
  let decodeError: unknown;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from([0xff]));
  } catch (error) {
    decodeError = error;
  }
  expect(isInvalidUtf8(decodeError)).toBe(true);
  expect(isInvalidUtf8(new TypeError('unrelated programming failure'))).toBe(false);
  expect(isInvalidUtf8(new Error('vendor response text'))).toBe(false);
});
