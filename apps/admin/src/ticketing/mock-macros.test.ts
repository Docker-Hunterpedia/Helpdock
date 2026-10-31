import type { MacroCreateRequest } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { MOCK_MACRO_PERSONAL, MOCK_MACRO_REFUND, MockMacros } from './mock-macros.js';

const BILLING = '0192c3f0-1a2b-7c3d-8e4f-0000000000d2';
const SUPPORT = '0192c3f0-1a2b-7c3d-8e4f-0000000000d1';

describe('MockMacros', () => {
  it('seeds the artboard’s seven, sorted by name', () => {
    const { macros } = new MockMacros().list();

    expect(macros).toHaveLength(7);
    expect(macros[0]?.name).toBe('Ask for the order number');
  });

  it('narrows as the api does: kind, text, and what a department may use', () => {
    const store = new MockMacros();

    expect(store.list({ kind: 'macro' }).macros.every((row) => row.kind === 'macro')).toBe(true);
    expect(store.list({ q: 'customs' }).macros.map((row) => row.name)).toEqual([
      'Shipping fees explained',
    ]);
    const support = store.list({ departmentId: SUPPORT }).macros.map((row) => row.id);
    expect(support).toContain(MOCK_MACRO_PERSONAL);
    expect(support).not.toContain(MOCK_MACRO_REFUND);
  });

  it('creates, updates, touches and removes, refusing a shape the api would', () => {
    const store = new MockMacros();

    const created = store.create({
      kind: 'canned',
      name: 'Thanks',
      scope: 'personal',
      departmentId: BILLING,
      bodies: { en: 'Thanks', ar: '' },
      shortcut: null,
      actions: [],
    });
    expect(created.departmentId).toBeNull();

    expect(store.update(created.id, { scope: 'shared', departmentId: BILLING }).departmentId).toBe(
      BILLING,
    );
    expect(() => store.update(created.id, { bodies: { en: '', ar: '' } })).toThrow(
      'A canned response needs its English text',
    );

    store.touch(created.id);
    expect(store.find(created.id)?.lastUsedAt).not.toBeNull();
    expect(store.find(created.id)?.useCount).toBe(1);

    store.remove(created.id);
    expect(store.find(created.id)).toBeUndefined();
    expect(() => {
      store.remove(created.id);
    }).toThrow('No such macro');
  });

  it('refuses a shortcut another item offered in the same place has, as the api does (M14-14)', () => {
    const store = new MockMacros();
    const shape: Omit<MacroCreateRequest, 'name' | 'shortcut'> = {
      kind: 'canned',
      scope: 'shared',
      departmentId: null,
      bodies: { en: 'Hi', ar: '' },
      actions: [],
    };

    expect(() => store.create({ ...shape, name: 'Again', shortcut: 'refund' })).toThrow(
      expect.objectContaining({ reason: 'shortcut-taken' }) as Error,
    );
    // The personal item meets a shared one, and an item keeps its own on save.
    expect(() =>
      store.create({ ...shape, name: 'Mine', scope: 'personal', shortcut: 'shipping' }),
    ).toThrow();
    expect(store.update(MOCK_MACRO_REFUND, { name: 'Refund issued' }).shortcut).toBe('refund');
    expect(store.update(MOCK_MACRO_REFUND, { shortcut: null }).shortcut).toBeNull();
    expect(store.create({ ...shape, name: 'Free now', shortcut: 'refund' }).shortcut).toBe(
      'refund',
    );
  });

  it('refuses an unknown placeholder, as the api does (M14-14)', () => {
    expect(() =>
      new MockMacros().create({
        kind: 'canned',
        name: 'Typo',
        scope: 'shared',
        departmentId: null,
        bodies: { en: 'Hi {{agent.nmae}}', ar: '' },
        shortcut: null,
        actions: [],
      }),
    ).toThrow('Unknown placeholder {{agent.nmae}}');
  });
});
