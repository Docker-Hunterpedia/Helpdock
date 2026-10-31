import type { Macro } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { byShortcut, matchSavedReplies, sortByUse } from './saved-reply-order.js';

const macro = (overrides: Partial<Macro> & { name: string }): Macro => ({
  id: overrides.name,
  kind: 'canned',
  scope: 'shared',
  departmentId: null,
  bodies: { en: 'text', ar: '' },
  shortcut: null,
  actions: [],
  lastUsedAt: null,
  useCount: 0,
  updatedAt: '2026-10-01T00:00:00Z',
  updatedById: null,
  canEdit: true,
  ...overrides,
});

const names = (rows: readonly Macro[]): string[] => rows.map((row) => row.name);

describe('sortByUse', () => {
  it('puts the reader’s own first, then the most recently used, then the most used, then by name', () => {
    const rows = [
      macro({ name: 'z shared never' }),
      macro({ name: 'b shared old', lastUsedAt: '2026-09-01T00:00:00Z', useCount: 99 }),
      macro({ name: 'a shared new', lastUsedAt: '2026-10-01T00:00:00Z', useCount: 1 }),
      macro({ name: 'c personal', scope: 'personal' }),
      macro({ name: 'a shared never', useCount: 5 }),
    ];

    expect(names(sortByUse(rows))).toEqual([
      'c personal',
      'a shared new',
      'b shared old',
      'a shared never',
      'z shared never',
    ]);
  });

  it('does not change the list it was given', () => {
    const rows = [macro({ name: 'b' }), macro({ name: 'a' })];
    sortByUse(rows);
    expect(names(rows)).toEqual(['b', 'a']);
  });
});

describe('matchSavedReplies', () => {
  const rows = [
    macro({ name: 'Return policy', shortcut: 'returns', useCount: 9 }),
    macro({ name: 'Refund timelines', shortcut: 'refund', useCount: 1 }),
    macro({ name: 'Partial refund', shortcut: 'partial' }),
    macro({ name: 'Escalate', kind: 'macro', shortcut: 'fin' }),
  ];

  it('offers everything in use order for an empty word', () => {
    expect(names(matchSavedReplies(rows, ''))).toEqual([
      'Return policy',
      'Refund timelines',
      'Escalate',
      'Partial refund',
    ]);
  });

  it('puts the exact shortcut first, then prefixes, then names that contain the word', () => {
    expect(names(matchSavedReplies(rows, 'refund'))).toEqual([
      'Refund timelines',
      'Partial refund',
    ]);
    expect(names(matchSavedReplies(rows, 're'))).toEqual([
      'Return policy',
      'Refund timelines',
      'Partial refund',
    ]);
  });

  it('matches in either case and ignores spaces around the word', () => {
    expect(names(matchSavedReplies(rows, ' FIN '))).toEqual(['Escalate']);
  });

  it('is empty when nothing matches', () => {
    expect(matchSavedReplies(rows, 'zzz')).toEqual([]);
  });
});

describe('byShortcut', () => {
  it('finds the exact shortcut only', () => {
    const rows = [macro({ name: 'A', shortcut: 'refund' })];
    expect(byShortcut(rows, 'refund')?.name).toBe('A');
    expect(byShortcut(rows, 'ref')).toBeUndefined();
    expect(byShortcut(rows, '')).toBeUndefined();
  });

  it('prefers the reader’s own when both a personal and a shared item answer', () => {
    const rows = [
      macro({ name: 'Shared', shortcut: 'hi' }),
      macro({ name: 'Mine', shortcut: 'hi', scope: 'personal' }),
    ];
    expect(byShortcut(rows, 'hi')?.name).toBe('Mine');
  });
});
