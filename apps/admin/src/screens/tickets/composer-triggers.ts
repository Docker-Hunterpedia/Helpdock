/**
 * What the composer reads out of the text and the caret to know that a list
 * should open (M14-14 for `/` and `{{`). Pure, so the boundary rules are
 * tested without a textarea.
 *
 * A trigger only counts when the caret is at its end: a `/` the person has
 * typed past, or clicked back to, is text.
 */

export type ComposerTrigger =
  | {
      /** `/refund`: saved replies and macros. */
      readonly kind: 'slash';
      readonly start: number;
      readonly end: number;
      readonly query: string;
    }
  | {
      /** `{{con`: the placeholder list. */
      readonly kind: 'placeholder';
      readonly start: number;
      readonly end: number;
      readonly query: string;
    };

export interface TriggerOptions {
  /** Replies only: a note has no saved replies. */
  readonly slash: boolean;
}

/** A `/` at the start of the text, a line, or after a space, and the word after it. */
const SLASH = /(?:^|\s)(\/([\p{L}\p{N}_-]*))$/u;
/** `{{` and whatever of a name has been typed after it. */
const BRACES = /(\{\{\s*([a-z_.]*))$/iu;

export const detectTrigger = (
  text: string,
  caret: number,
  options: TriggerOptions,
): ComposerTrigger | null => {
  const before = text.slice(0, caret);

  const braces = BRACES.exec(before);
  if (braces?.[1] !== undefined) {
    return {
      kind: 'placeholder',
      start: caret - braces[1].length,
      end: caret,
      query: braces[2] ?? '',
    };
  }

  const slash = options.slash ? SLASH.exec(before) : null;
  if (slash?.[1] !== undefined) {
    return {
      kind: 'slash',
      start: caret - slash[1].length,
      end: caret,
      query: slash[2] ?? '',
    };
  }

  return null;
};

/** `text` with `[start, end)` replaced, and where the caret goes. */
export const replaceRange = (
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } => ({
  text: `${text.slice(0, start)}${insert}${text.slice(end)}`,
  caret: start + insert.length,
});

/**
 * `text` with the trigger word replaced by what it chose. The range was true when
 * the choice was made; a choice that takes a moment to arrive (a reply filled in
 * by the api) may find the text has moved on, and then the word is looked for,
 * and failing that the reply is added after what was typed.
 */
export const replaceTrigger = (
  text: string,
  range: { readonly start: number; readonly end: number },
  word: string,
  insert: string,
): { text: string; caret: number } => {
  if (text.slice(range.start, range.end) === word) {
    return replaceRange(text, range.start, range.end, insert);
  }
  const at = text.indexOf(word);
  if (at !== -1) {
    return replaceRange(text, at, at + word.length, insert);
  }
  const joined = text.trim() === '' ? insert : `${text.trimEnd()}\n\n${insert}`;

  return { text: joined, caret: joined.length };
};
