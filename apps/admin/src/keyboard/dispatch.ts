import { isModifierOnly, type KeyEventLike, keyOf, strokeMatches } from './keys.js';
import { isSequence, SHORTCUT_LIST, type Shortcut, type ShortcutId } from './registry.js';

/**
 * Which shortcut a key press is, if any: the rules of M14-01 as a pure
 * function, so they are tested without a browser.
 *
 * - **Nothing without a modifier while somebody is writing**, in a dialog or
 *   a menu, or with the single-key switch off (WCAG 2.1.4). A shortcut that
 *   carries `⌘`/`Ctrl` still answers in a field.
 * - **A composer shortcut answers only inside the composer**, so `⌘Enter` in
 *   the list's search box sends nothing.
 * - **`g` then a letter within 1.5 s** is a sequence. The `g` waits; another
 *   character typed on the page ends the wait and does nothing else, so a
 *   stray letter after `g` is never taken for a shortcut of its own. Any other
 *   key (Tab, Esc, a chord) ends the wait and is itself.
 */

export const SEQUENCE_WINDOW_MS = 1500;

export interface PendingSequence {
  /** The first stroke's key: `g`. */
  readonly prefix: string;
  readonly at: number;
}

export interface DispatchContext {
  readonly now: number;
  readonly singleKeys: boolean;
  /** The caret is in a field, a select or a rich-text area. */
  readonly typing: boolean;
  /** The press happened in a dialog, a menu or a listbox. */
  readonly inOverlay: boolean;
  /** The press happened inside the composer. */
  readonly inComposer: boolean;
  /** Whether a handler is attached for the id and the person may use it. */
  readonly available: (id: ShortcutId) => boolean;
}

export interface DispatchResult {
  /** The shortcut to run, or null. */
  readonly id: ShortcutId | null;
  /** The sequence now waiting for its second key, or null. */
  readonly pending: PendingSequence | null;
  /** Whether the press was used, so the browser should not act on it too. */
  readonly consumed: boolean;
}

const NOTHING: DispatchResult = { id: null, pending: null, consumed: false };

type Strokes = Shortcut['keys'];

/** The key lists a shortcut answers to here and now: its keys and any alternates. */
const usableStrokes = (shortcut: Shortcut, context: DispatchContext): readonly Strokes[] => {
  if (shortcut.typed === true || !context.available(shortcut.id)) {
    return [];
  }
  if (shortcut.scope === 'composer' && !context.inComposer) {
    return [];
  }
  return [shortcut.keys, ...(shortcut.alternates ?? [])].filter((strokes) => {
    if (strokes[0]?.mod === true) {
      return true;
    }
    return context.singleKeys && !context.typing && !context.inOverlay;
  });
};

const isPlainCharacter = (event: KeyEventLike, context: DispatchContext): boolean => {
  const key = keyOf(event);
  return (
    key !== null &&
    key.length === 1 &&
    event.metaKey !== true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    !context.typing &&
    !context.inOverlay
  );
};

export function resolveShortcut(
  event: KeyEventLike,
  pending: PendingSequence | null,
  context: DispatchContext,
): DispatchResult {
  if (isModifierOnly(event)) {
    // Shift on the way to `?` neither ends a sequence nor starts anything.
    return { ...NOTHING, pending };
  }

  const candidates = SHORTCUT_LIST.map((shortcut) => ({
    shortcut,
    strokes: usableStrokes(shortcut, context),
  })).filter(({ strokes }) => strokes.length > 0);
  const sequences = candidates.filter(({ shortcut }) => isSequence(shortcut));
  const waiting = pending !== null && context.now - pending.at <= SEQUENCE_WINDOW_MS;

  // Only a character typed on the page can be a sequence's second key. Tab,
  // Esc, a chord such as ⌘\, or a key in a field ends the wait and is then
  // whatever it would have been without the `g`.
  if (waiting && isPlainCharacter(event, context)) {
    const second = sequences.find(
      ({ shortcut: { keys } }) =>
        keys[0]?.key === pending.prefix && keys[1] !== undefined && strokeMatches(keys[1], event),
    );
    return { id: second?.shortcut.id ?? null, pending: null, consumed: true };
  }

  const starts = sequences.some(
    ({ shortcut: { keys } }) => keys[0] !== undefined && strokeMatches(keys[0], event),
  );
  if (starts) {
    const prefix = keyOf(event);
    /* c8 ignore next 3 -- a stroke that matched has a key. */
    if (prefix === null) {
      return NOTHING;
    }
    return { id: null, pending: { prefix, at: context.now }, consumed: true };
  }

  const single = candidates.find(
    ({ shortcut, strokes }) =>
      !isSequence(shortcut) &&
      strokes.some((keys) => keys[0] !== undefined && strokeMatches(keys[0], event)),
  );
  return single === undefined ? NOTHING : { id: single.shortcut.id, pending: null, consumed: true };
}
