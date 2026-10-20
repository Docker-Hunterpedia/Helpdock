/**
 * What a key press *is*, independent of the keyboard layout it was typed on.
 *
 * A letter is the one a Latin layout types, so a Dvorak or AZERTY user presses
 * the key engraved with the letter the sheet shows. A layout that types no
 * Latin letter at all — Arabic, where the J key types `ت`, or Russian — falls
 * back to the physical key (`event.code`, `KeyJ`), which is where the Latin
 * letter is engraved on a bilingual keyboard. `?` is also the Arabic `؟`
 * (U+061F), which the same key types on an Arabic layout.
 */

/** One press: a key, and whether `⌘`/`Ctrl` and Shift are held with it. */
export interface KeyStroke {
  /** A lower-case letter, a character such as `/` or `?`, or `Enter`. */
  readonly key: string;
  /** `⌘` on a Mac, `Ctrl` elsewhere; either is taken on any platform. */
  readonly mod?: true;
  readonly shift?: true;
}

/** The parts of a `KeyboardEvent` this module reads, so tests need no DOM event. */
export interface KeyEventLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

const ARABIC_QUESTION_MARK = '؟';
const LATIN_LETTER = /^[a-z]$/i;
/** A printable ASCII character other than a letter: `/`, `?`, `\`, a digit. */
const ASCII_SYMBOL = /^[!-@[-`{-~]$/;
const NAMED_KEYS = new Set(['Enter', 'Escape']);
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** The character the physical key types on a US layout, for a layout that types something else. */
const fromCode = (code: string | undefined, shift: boolean): string | null => {
  if (code === undefined) {
    return null;
  }
  if (code.startsWith('Key')) {
    return code.slice(3).toLowerCase();
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  if (code === 'Slash') {
    return shift ? '?' : '/';
  }
  if (code === 'Backslash') {
    return '\\';
  }
  return null;
};

/** The key a press names, in the vocabulary of {@link KeyStroke.key}, or null for none. */
export const keyOf = (event: KeyEventLike): string | null => {
  const { key } = event;
  if (key === ARABIC_QUESTION_MARK) {
    return '?';
  }
  if (LATIN_LETTER.test(key)) {
    return key.toLowerCase();
  }
  if (ASCII_SYMBOL.test(key) || NAMED_KEYS.has(key)) {
    return key;
  }
  return fromCode(event.code, event.shiftKey === true);
};

/** A press of Shift, Ctrl and the like on its own, which starts nothing and ends nothing. */
export const isModifierOnly = (event: KeyEventLike): boolean => MODIFIER_KEYS.has(event.key);

/**
 * Whether `event` is `stroke`. Shift is compared for letters and named keys
 * only: `?` needs Shift on one layout and not on another, and the character
 * already says which key it was.
 */
export const strokeMatches = (stroke: KeyStroke, event: KeyEventLike): boolean => {
  const mod = event.metaKey === true || event.ctrlKey === true;
  if (event.altKey === true || mod !== (stroke.mod === true)) {
    return false;
  }
  const key = keyOf(event);
  if (key !== stroke.key) {
    return false;
  }
  const shiftMatters = LATIN_LETTER.test(stroke.key) || NAMED_KEYS.has(stroke.key);
  return !shiftMatters || (event.shiftKey === true) === (stroke.shift === true);
};

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Whether the keystroke belongs to whatever the person is writing in. */
export const isTyping = (target: EventTarget | null | undefined): boolean =>
  target instanceof HTMLElement && (TYPING_TAGS.has(target.tagName) || target.isContentEditable);

/**
 * Whether the keystroke happened inside a dialog, a menu or a listbox, whose
 * own keys (letters that jump to an option, `Esc`) win over the page's.
 */
export const isInOverlay = (target: EventTarget | null | undefined): boolean =>
  target instanceof Element &&
  target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

/** The caps a stroke is drawn with: `⌘` or `Ctrl`, `Shift`, then the key. */
export const keyCaps = (stroke: KeyStroke, mac: boolean): readonly string[] => [
  ...(stroke.mod === true ? [mac ? '⌘' : 'Ctrl'] : []),
  ...(stroke.shift === true ? ['Shift'] : []),
  stroke.key === 'Escape' ? 'Esc' : stroke.key,
];

/**
 * One stroke in the syntax of `aria-keyshortcuts`, both modifiers offered
 * since either works: `Meta+Enter Control+Enter`.
 */
export const ariaStroke = (stroke: KeyStroke): string => {
  const rest = [...(stroke.shift === true ? ['Shift'] : []), stroke.key].join('+');
  return stroke.mod === true ? `Meta+${rest} Control+${rest}` : rest;
};
