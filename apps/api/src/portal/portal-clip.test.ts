import { describe, expect, it } from 'vitest';
import {
  clipLine,
  clipText,
  FILE_NAME_MAX,
  FILES_PER_MESSAGE_MAX,
  MESSAGE_TEXT_MAX,
  SUBJECT_MAX,
} from './portal-clip.js';

describe('clipText', () => {
  it('leaves text within the limit alone', () => {
    expect(clipText('abc', 3)).toEqual({ text: 'abc', clipped: false });
  });

  it('cuts to the limit with an ellipsis, so the result never exceeds it', () => {
    const clipped = clipText('a'.repeat(MESSAGE_TEXT_MAX + 500), MESSAGE_TEXT_MAX);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text).toHaveLength(MESSAGE_TEXT_MAX);
    expect(clipped.text.endsWith('…')).toBe(true);
  });

  it('never cuts inside a surrogate pair', () => {
    const clipped = clipText(`${'a'.repeat(9)}😀😀`, 11);
    expect(clipped.text).toBe(`${'a'.repeat(9)}…`);
    expect(clipped.text.length).toBeLessThanOrEqual(11);
    expect(clipLine('😀'.repeat(1000), SUBJECT_MAX).length).toBeLessThanOrEqual(SUBJECT_MAX);
  });

  it('has the limits the schemas have', () => {
    expect([SUBJECT_MAX, FILE_NAME_MAX, MESSAGE_TEXT_MAX, FILES_PER_MESSAGE_MAX]).toEqual([
      1000, 255, 200_000, 50,
    ]);
  });
});
