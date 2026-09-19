import { describe, expect, it } from 'vitest';
import { moveBy, moveTo, positionOf } from './reorder.js';

const ids = ['a', 'b', 'c', 'd'];

describe('positionOf', () => {
  it('answers -1 for an id the list does not have', () => {
    expect(positionOf(ids, 'z')).toBe(-1);
    expect(positionOf(ids, 'c')).toBe(2);
  });
});

describe('moveTo', () => {
  it('moves an item to a later position', () => {
    expect(moveTo(ids, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item to an earlier position', () => {
    expect(moveTo(ids, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('clamps to the ends rather than dropping the item', () => {
    expect(moveTo(ids, 'c', -5)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveTo(ids, 'b', 99)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('returns the same array when nothing would change, so the caller can skip the request', () => {
    expect(moveTo(ids, 'a', 0)).toBe(ids);
    expect(moveTo(ids, 'z', 1)).toBe(ids);
  });
});

describe('moveBy', () => {
  it('walks one place at a time, which is what the row menu asks for', () => {
    expect(moveBy(ids, 'c', -1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveBy(ids, 'c', 1)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('does nothing at the ends', () => {
    expect(moveBy(ids, 'a', -1)).toBe(ids);
    expect(moveBy(ids, 'd', 1)).toBe(ids);
  });

  it('ignores an id the list does not have', () => {
    expect(moveBy(ids, 'z', -1)).toBe(ids);
  });

  it('agrees with the drag: one step up is the same as moving to the slot above', () => {
    expect(moveBy(ids, 'c', -1)).toEqual(moveTo(ids, 'c', 1));
  });
});
