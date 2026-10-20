import { describe, expect, it } from 'vitest';
import {
  type DispatchContext,
  type PendingSequence,
  resolveShortcut,
  SEQUENCE_WINDOW_MS,
} from './dispatch.js';
import type { KeyEventLike } from './keys.js';
import { isSingleKey, SHORTCUT_LIST, type ShortcutId } from './registry.js';

const NOW = 1_000_000;

const context = (overrides: Partial<DispatchContext> = {}): DispatchContext => ({
  now: NOW,
  singleKeys: true,
  typing: false,
  inOverlay: false,
  inComposer: false,
  available: () => true,
  ...overrides,
});

const press = (
  event: KeyEventLike,
  pending: PendingSequence | null = null,
  overrides: Partial<DispatchContext> = {},
) => resolveShortcut(event, pending, context(overrides));

/** The press that types a stroke on a US layout. */
const eventFor = (stroke: { key: string; mod?: true; shift?: true }): KeyEventLike => ({
  key: stroke.key,
  ...(stroke.mod === true ? { ctrlKey: true } : {}),
  ...(stroke.shift === true ? { shiftKey: true } : {}),
});

describe('resolveShortcut', () => {
  it('names the shortcut a single key is', () => {
    expect(press({ key: 'j', code: 'KeyJ' })).toEqual({
      id: 'list.next',
      pending: null,
      consumed: true,
    });
    expect(press({ key: '?', code: 'Slash', shiftKey: true }).id).toBe('general.shortcuts');
  });

  it('answers the same physical keys on an Arabic layout', () => {
    expect(press({ key: 'ت', code: 'KeyJ' }).id).toBe('list.next');
    expect(press({ key: 'ق', code: 'KeyR' }).id).toBe('ticket.reply');
    expect(press({ key: '؟', code: 'Slash', shiftKey: true }).id).toBe('general.shortcuts');
  });

  it('leaves a key that is no shortcut to the browser', () => {
    expect(press({ key: 'q', code: 'KeyQ' })).toEqual({ id: null, pending: null, consumed: false });
  });

  it('says nothing for a shortcut with no handler attached, or not the person’s to use', () => {
    const without = (missing: ShortcutId) => ({
      available: (id: ShortcutId) => id !== missing,
    });

    expect(press({ key: 'e', code: 'KeyE' }, null, without('list.close')).id).toBeNull();
  });

  describe('g sequences', () => {
    const g = { key: 'g', code: 'KeyG' };

    it('waits after g, and names the shortcut of the second key', () => {
      const first = press(g);
      expect(first).toEqual({ id: null, pending: { prefix: 'g', at: NOW }, consumed: true });

      const second = press({ key: 'i', code: 'KeyI' }, first.pending, { now: NOW + 400 });
      expect(second).toEqual({ id: 'goTo.myOpen', pending: null, consumed: true });
    });

    it('works on an Arabic layout, where g types ل', () => {
      const first = press({ key: 'ل', code: 'KeyG' });
      expect(press({ key: 'ع', code: 'KeyU' }, first.pending).id).toBe('goTo.unassigned');
    });

    it('takes g c for Contacts, never for a new ticket', () => {
      const first = press(g);
      expect(press({ key: 'c', code: 'KeyC' }, first.pending).id).toBe('goTo.contacts');
    });

    it('ends the wait on any other key and does nothing with it', () => {
      const first = press(g);
      expect(press({ key: 'j', code: 'KeyJ' }, first.pending)).toEqual({
        id: null,
        pending: null,
        consumed: true,
      });
    });

    it('lets a lone Shift pass without ending the wait', () => {
      const first = press(g);
      expect(press({ key: 'Shift', code: 'ShiftLeft' }, first.pending).pending).toEqual(
        first.pending,
      );
    });

    it(`gives up after ${SEQUENCE_WINDOW_MS} ms, and the late key is itself again`, () => {
      const first = press(g);
      const late = press({ key: 'j', code: 'KeyJ' }, first.pending, {
        now: NOW + SEQUENCE_WINDOW_MS + 1,
      });
      expect(late.id).toBe('list.next');

      const onTime = press({ key: 'o', code: 'KeyO' }, first.pending, {
        now: NOW + SEQUENCE_WINDOW_MS,
      });
      expect(onTime.id).toBe('goTo.overdue');
    });

    it('does nothing with a second key whose page the person is not offered', () => {
      const first = press(g);
      const reports = press({ key: 'r', code: 'KeyR' }, first.pending, {
        available: (id) => id !== 'goTo.reports',
      });
      expect(reports.id).toBeNull();
    });
  });

  describe('the single-key switch (WCAG 2.1.4)', () => {
    const off = { singleKeys: false };

    it.each(
      SHORTCUT_LIST.filter(isSingleKey).map((shortcut) => [shortcut.id, shortcut.keys[0]] as const),
    )('turns %s off', (_id, stroke) => {
      expect(stroke).toBeDefined();
      const result = press(eventFor(stroke ?? { key: '' }), null, off);
      expect(result.id).toBeNull();
      expect(result.pending).toBeNull();
    });

    it('leaves the shortcuts with a modifier on', () => {
      expect(press({ key: '\\', code: 'Backslash', metaKey: true }, null, off).id).toBe(
        'general.sidebar',
      );
      expect(
        press({ key: 'Enter', ctrlKey: true }, null, { ...off, typing: true, inComposer: true }).id,
      ).toBe('composer.send');
    });
  });

  describe('while somebody is writing', () => {
    it('leaves letters to the field', () => {
      expect(press({ key: 'r', code: 'KeyR' }, null, { typing: true }).id).toBeNull();
      expect(press({ key: 'g', code: 'KeyG' }, null, { typing: true }).pending).toBeNull();
    });

    it('still answers a shortcut with a modifier', () => {
      expect(
        press({ key: '\\', code: 'Backslash', ctrlKey: true }, null, { typing: true }).id,
      ).toBe('general.sidebar');
    });
  });

  it('leaves letters to a dialog, a menu or a listbox', () => {
    expect(press({ key: 'j', code: 'KeyJ' }, null, { inOverlay: true }).id).toBeNull();
  });

  describe('composer shortcuts', () => {
    const inComposer = { typing: true, inComposer: true };

    it('send with ⌘ or Ctrl and Enter, and send and close with Shift too', () => {
      expect(press({ key: 'Enter', metaKey: true }, null, inComposer).id).toBe('composer.send');
      expect(press({ key: 'Enter', ctrlKey: true, shiftKey: true }, null, inComposer).id).toBe(
        'composer.sendAndClose',
      );
    });

    it('answer only inside the composer, so ⌘Enter in a search box sends nothing', () => {
      expect(press({ key: 'Enter', metaKey: true }, null, { typing: true }).id).toBeNull();
    });

    it('never take a plain Enter, which is a new line', () => {
      expect(press({ key: 'Enter' }, null, inComposer).id).toBeNull();
    });

    it('leave `/` to the text, where the composer reads it', () => {
      expect(press({ key: '/', code: 'Slash' }, null, inComposer).id).toBeNull();
    });
  });
});
