/**
 * Text folding for the command palette's local matching (M14-05).
 *
 * The same folding the help center's index applies in SQL
 * (`packages/db/src/schema/help-center-search.ts`): case, Arabic diacritics
 * and tatweel dropped, every alef form to a bare alef, alef maqsura to yaa and
 * taa marbuta to haa. A person types "اتفاقيه" for "اتفاقية" and finds it.
 */
const DIACRITICS = /[ً-ٰٟـ]/g;

const FOLDS: Readonly<Record<string, string>> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ى: 'ي',
  ة: 'ه',
};

export const fold = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآٱىة]/g, (letter) => FOLDS[letter] ?? letter)
    .replace(/\s+/g, ' ')
    .trim();

/** How well a query matches a text, 0 for not at all; higher is better. */
export type MatchRank = 0 | 1 | 2 | 3;

/**
 * Every word of the query has to appear in the text, in any order. A text that
 * starts with the query ranks first, then one with a word that does, then any
 * other containing match.
 */
export const matchRank = (query: string, text: string): MatchRank => {
  const folded = fold(text);
  const wanted = fold(query);
  if (wanted === '') {
    return 0;
  }
  if (folded.startsWith(wanted)) {
    return 3;
  }
  const words = wanted.split(' ');
  if (!words.every((word) => folded.includes(word))) {
    return 0;
  }
  return folded.split(' ').some((word) => word.startsWith(words[0] ?? '')) ? 2 : 1;
};

/** The best rank of a query against any of several texts. */
export const bestRank = (query: string, texts: readonly string[]): MatchRank =>
  texts.reduce<MatchRank>((best, text) => Math.max(best, matchRank(query, text)) as MatchRank, 0);
