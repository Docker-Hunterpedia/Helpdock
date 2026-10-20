import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forget, RECENTS_LIMIT, readRecents, recentsKey, remember } from './recents.js';

const USER = 'user-1';
const BRAND = 'brand-1';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recents', () => {
  it('is empty before anything is opened', () => {
    expect(readRecents(USER, BRAND)).toEqual([]);
  });

  it('puts the newest first and moves a repeat to the front once', () => {
    remember(USER, BRAND, { kind: 'ticket', id: 'a' });
    remember(USER, BRAND, { kind: 'contact', id: 'b' });
    remember(USER, BRAND, { kind: 'ticket', id: 'a' });

    expect(readRecents(USER, BRAND)).toEqual([
      { kind: 'ticket', id: 'a' },
      { kind: 'contact', id: 'b' },
    ]);
  });

  it('keeps the same id of two kinds apart', () => {
    remember(USER, BRAND, { kind: 'ticket', id: 'same' });
    remember(USER, BRAND, { kind: 'contact', id: 'same' });

    expect(readRecents(USER, BRAND)).toHaveLength(2);
  });

  it('keeps only the newest few', () => {
    for (let index = 0; index < RECENTS_LIMIT + 3; index += 1) {
      remember(USER, BRAND, { kind: 'ticket', id: `t${index}` });
    }

    const kept = readRecents(USER, BRAND);
    expect(kept).toHaveLength(RECENTS_LIMIT);
    expect(kept[0]).toEqual({ kind: 'ticket', id: `t${RECENTS_LIMIT + 2}` });
  });

  it('keeps each person and brand to their own list', () => {
    remember(USER, BRAND, { kind: 'ticket', id: 'a' });

    expect(readRecents('user-2', BRAND)).toEqual([]);
    expect(readRecents(USER, 'brand-2')).toEqual([]);
  });

  it('stores ids and kinds and nothing else', () => {
    remember(USER, BRAND, { kind: 'ticket', id: 'a' });

    expect(JSON.parse(localStorage.getItem(recentsKey(USER, BRAND)) ?? '')).toEqual([
      { kind: 'ticket', id: 'a' },
    ]);
  });

  it('forgets what it is told is gone', () => {
    remember(USER, BRAND, { kind: 'ticket', id: 'a' });
    remember(USER, BRAND, { kind: 'ticket', id: 'b' });

    forget(USER, BRAND, [{ kind: 'ticket', id: 'a' }]);

    expect(readRecents(USER, BRAND)).toEqual([{ kind: 'ticket', id: 'b' }]);
  });

  it('reads nothing from a value that is not a list of recents', () => {
    localStorage.setItem(recentsKey(USER, BRAND), '{"kind":"ticket"}');
    expect(readRecents(USER, BRAND)).toEqual([]);

    localStorage.setItem(recentsKey(USER, BRAND), 'not json');
    expect(readRecents(USER, BRAND)).toEqual([]);
  });

  it('drops entries of an unknown kind and any extra field', () => {
    localStorage.setItem(
      recentsKey(USER, BRAND),
      JSON.stringify([
        { kind: 'ticket', id: 'a', subject: 'Refund for Mona' },
        { kind: 'secret', id: 'b' },
        { kind: 'page', id: 3 },
      ]),
    );

    expect(readRecents(USER, BRAND)).toEqual([{ kind: 'ticket', id: 'a' }]);
  });

  it('works without storage: reads empty, and remembering does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });

    expect(readRecents(USER, BRAND)).toEqual([]);
    expect(() => remember(USER, BRAND, { kind: 'ticket', id: 'a' })).not.toThrow();
    expect(() => forget(USER, BRAND, [{ kind: 'ticket', id: 'a' }])).not.toThrow();
  });
});
