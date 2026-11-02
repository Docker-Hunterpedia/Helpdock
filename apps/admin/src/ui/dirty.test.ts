import { describe, expect, it } from 'vitest';
import { isDirty } from './dirty.js';

describe('isDirty', () => {
  it('is clean for equal drafts, however they were built', () => {
    expect(isDirty({ a: 'x', b: [1, { c: true }] }, { b: [1, { c: true }], a: 'x' })).toBe(false);
    expect(isDirty('same', 'same')).toBe(false);
    expect(isDirty(null, null)).toBe(false);
  });

  it('is dirty when a field, an array item or the array length differs', () => {
    expect(isDirty({ a: 'x' }, { a: 'y' })).toBe(true);
    expect(isDirty({ a: [1, 2] }, { a: [1, 3] })).toBe(true);
    expect(isDirty({ a: [1] }, { a: [1, 2] })).toBe(true);
    expect(isDirty({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(isDirty(null, {})).toBe(true);
  });

  it('is clean again once an edit is undone', () => {
    const saved = { name: 'Lina' };
    expect(isDirty({ name: 'Lina H' }, saved)).toBe(true);
    expect(isDirty({ name: 'Lina' }, saved)).toBe(false);
  });
});
