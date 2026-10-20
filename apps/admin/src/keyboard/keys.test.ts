import { describe, expect, it } from 'vitest';
import {
  ariaStroke,
  isInOverlay,
  isModifierOnly,
  isTyping,
  keyCaps,
  keyOf,
  strokeMatches,
} from './keys.js';

const element = (tag: string, contentEditable = false): HTMLElement => {
  const node = document.createElement(tag);
  if (contentEditable) {
    node.contentEditable = 'true';
  }
  return node;
};

describe('keyOf', () => {
  it('reads a Latin letter as the letter, whatever its case', () => {
    expect(keyOf({ key: 'j', code: 'KeyJ' })).toBe('j');
    expect(keyOf({ key: 'R', code: 'KeyR' })).toBe('r');
  });

  it('reads an Arabic layout by the physical key, where the J key types ت', () => {
    expect(keyOf({ key: 'ت', code: 'KeyJ' })).toBe('j');
    expect(keyOf({ key: 'ل', code: 'KeyG' })).toBe('g');
    expect(keyOf({ key: 'ء', code: 'KeyX' })).toBe('x');
  });

  it('follows the letter on a Latin layout that moves it, so Dvorak’s j is still j', () => {
    expect(keyOf({ key: 'h', code: 'KeyJ' })).toBe('h');
    expect(keyOf({ key: 'j', code: 'KeyC' })).toBe('j');
  });

  it('takes the Arabic question mark for ?', () => {
    expect(keyOf({ key: '؟', code: 'Slash', shiftKey: true })).toBe('?');
    expect(keyOf({ key: '?', code: 'Slash', shiftKey: true })).toBe('?');
  });

  it('reads the slash key of a layout that types a letter there', () => {
    // The Arabic layout types ظ on the US slash key.
    expect(keyOf({ key: 'ظ', code: 'Slash' })).toBe('/');
    expect(keyOf({ key: 'ذ', code: 'Backslash' })).toBe('\\');
    expect(keyOf({ key: '١', code: 'Digit1' })).toBe('1');
  });

  it('keeps the named keys, and has nothing to say about the rest', () => {
    expect(keyOf({ key: 'Enter', code: 'Enter' })).toBe('Enter');
    expect(keyOf({ key: 'Escape', code: 'Escape' })).toBe('Escape');
    expect(keyOf({ key: 'ArrowDown', code: 'ArrowDown' })).toBeNull();
    expect(keyOf({ key: 'ت' })).toBeNull();
  });
});

describe('strokeMatches', () => {
  it('matches a single key without a modifier only', () => {
    expect(strokeMatches({ key: 'r' }, { key: 'r' })).toBe(true);
    expect(strokeMatches({ key: 'r' }, { key: 'r', metaKey: true })).toBe(false);
    expect(strokeMatches({ key: 'r' }, { key: 'r', ctrlKey: true })).toBe(false);
    expect(strokeMatches({ key: 'r' }, { key: 'r', altKey: true })).toBe(false);
  });

  it('takes Caps Lock’s capital as the letter, and Shift as another stroke', () => {
    expect(strokeMatches({ key: 'r' }, { key: 'R' })).toBe(true);
    expect(strokeMatches({ key: 'r' }, { key: 'R', shiftKey: true })).toBe(false);
  });

  it('matches ? with or without Shift, since the character says which key it was', () => {
    expect(strokeMatches({ key: '?' }, { key: '?', shiftKey: true })).toBe(true);
    expect(strokeMatches({ key: '?' }, { key: '؟', code: 'Slash', shiftKey: true })).toBe(true);
    expect(strokeMatches({ key: '?' }, { key: '/', code: 'Slash' })).toBe(false);
  });

  it('takes ⌘ and Ctrl alike for a modifier stroke', () => {
    const send = { key: 'Enter', mod: true } as const;
    expect(strokeMatches(send, { key: 'Enter', metaKey: true })).toBe(true);
    expect(strokeMatches(send, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(strokeMatches(send, { key: 'Enter' })).toBe(false);
    expect(strokeMatches(send, { key: 'Enter', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(
      strokeMatches(
        { key: 'Enter', mod: true, shift: true },
        { key: 'Enter', metaKey: true, shiftKey: true },
      ),
    ).toBe(true);
  });

  // 1.0.2's sidebar chord, which moved here from `shell/sidebar-collapse.ts`.
  it.each([
    { case: '⌘\\', keys: { key: '\\', code: 'Backslash', metaKey: true }, toggles: true },
    { case: 'Ctrl+\\', keys: { key: '\\', code: 'Backslash', ctrlKey: true }, toggles: true },
    {
      case: 'Ctrl+\\ on Arabic',
      keys: { key: 'ذ', code: 'Backslash', ctrlKey: true },
      toggles: true,
    },
    {
      case: 'a layout with \\ elsewhere',
      keys: { key: '\\', code: 'IntlBackslash', metaKey: true },
      toggles: true,
    },
    { case: '\\ alone', keys: { key: '\\', code: 'Backslash' }, toggles: false },
    {
      case: 'Ctrl+Shift+\\',
      keys: { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true },
      toggles: false,
    },
    {
      case: 'Ctrl+Alt+\\',
      keys: { key: '\\', code: 'Backslash', ctrlKey: true, altKey: true },
      toggles: false,
    },
    { case: 'Ctrl+K', keys: { key: 'k', code: 'KeyK', ctrlKey: true }, toggles: false },
  ])('$case is ⌘\\: $toggles', ({ keys, toggles }) => {
    expect(strokeMatches({ key: '\\', mod: true }, keys)).toBe(toggles);
  });
});

describe('isTyping', () => {
  it.each(['input', 'textarea', 'select'])('is true inside a %s', (tag) => {
    expect(isTyping(element(tag))).toBe(true);
  });

  it('is true inside a rich-text area', () => {
    expect(isTyping(element('div', true))).toBe(true);
  });

  it.each(['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'])(
    'is false on an input of type %s, which takes no letters',
    (type) => {
      const input = document.createElement('input');
      input.type = type;
      expect(isTyping(input)).toBe(false);
    },
  );

  it.each(['search', 'email', 'number', 'date'])('is true in an input of type %s', (type) => {
    const input = document.createElement('input');
    input.type = type;
    expect(isTyping(input)).toBe(true);
  });

  it('is false on the page itself', () => {
    expect(isTyping(element('div'))).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(undefined)).toBe(false);
  });
});

describe('isInOverlay', () => {
  it.each(['dialog', 'alertdialog', 'menu', 'listbox'])('is true inside a %s', (role) => {
    const overlay = element('div');
    overlay.setAttribute('role', role);
    const button = element('button');
    overlay.append(button);

    expect(isInOverlay(button)).toBe(true);
  });

  it('is false on the page itself', () => {
    expect(isInOverlay(element('button'))).toBe(false);
    expect(isInOverlay(null)).toBe(false);
  });
});

describe('isModifierOnly', () => {
  it('is a press of Shift, Ctrl, Alt or ⌘ on its own', () => {
    expect(isModifierOnly({ key: 'Shift' })).toBe(true);
    expect(isModifierOnly({ key: 'Meta' })).toBe(true);
    expect(isModifierOnly({ key: 'g' })).toBe(false);
  });
});

describe('keyCaps and ariaStroke', () => {
  it('draws ⌘ on a Mac and Ctrl elsewhere, then Shift, then the key', () => {
    const sendAndClose = { key: 'Enter', mod: true, shift: true } as const;
    expect(keyCaps(sendAndClose, true)).toEqual(['⌘', 'Shift', 'Enter']);
    expect(keyCaps(sendAndClose, false)).toEqual(['Ctrl', 'Shift', 'Enter']);
    expect(keyCaps({ key: 'Escape' }, false)).toEqual(['Esc']);
  });

  it('names both modifiers for aria-keyshortcuts, since either works', () => {
    expect(ariaStroke({ key: 'Enter', mod: true })).toBe('Meta+Enter Control+Enter');
    expect(ariaStroke({ key: 'Enter', mod: true, shift: true })).toBe(
      'Meta+Shift+Enter Control+Shift+Enter',
    );
    expect(ariaStroke({ key: 'r' })).toBe('r');
  });
});
