/**
 * The five keys the ticket workspace answers to, and — more importantly — when
 * it does not answer to them.
 *
 * A single letter is only a shortcut while nobody is writing. `r` inside the
 * composer is the letter r, and a screen that stole it would make the composer
 * unusable; so anything typed into a field, a select or a rich-text area is
 * left alone, and so is anything carrying a modifier, because `⌘R` is the
 * browser's.
 *
 * `Escape` is the exception and is always a shortcut: it is what closes the
 * drawer or the dialog that is covering the screen, and a person who pressed it
 * inside a field wants out of the field's surroundings.
 */

export type TicketShortcut = 'next' | 'previous' | 'reply' | 'note' | 'dismiss';

export interface ShortcutEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly target?: EventTarget | null;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Whether the keystroke belongs to whatever the person is writing in. */
export const isTyping = (target: EventTarget | null | undefined): boolean => {
  if (target === null || target === undefined || !(target instanceof HTMLElement)) {
    return false;
  }

  return TYPING_TAGS.has(target.tagName) || target.isContentEditable;
};

const LETTERS: Readonly<Record<string, TicketShortcut>> = {
  j: 'next',
  k: 'previous',
  r: 'reply',
  n: 'note',
};

export const shortcutFor = (event: ShortcutEvent): TicketShortcut | null => {
  if (event.key === 'Escape') {
    return 'dismiss';
  }

  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) {
    return null;
  }

  if (isTyping(event.target)) {
    return null;
  }

  return LETTERS[event.key.toLowerCase()] ?? null;
};
