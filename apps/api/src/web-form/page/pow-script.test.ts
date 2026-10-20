import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { POW_SCRIPT, POW_SHA256_SOURCE } from './pow-script.js';

/** The page's own text, compiled as the browser would compile it. */
const plainSha256 = new Function(`return ${POW_SHA256_SOURCE};`)() as (
  bytes: Uint8Array,
) => Uint8Array;

describe('the web form’s inline SHA-256, for a form served over http:// (ADR 0052)', () => {
  it.each([
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'abc123?expires=1792497600&surface=web-form&49999',
  ])('agrees with node:crypto on %j', (text) => {
    const bytes = new TextEncoder().encode(text);

    expect(Buffer.from(plainSha256(bytes)).toString('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('is a script a browser can compile', () => {
    expect(() => new Function(POW_SCRIPT)).not.toThrow();
  });
});
