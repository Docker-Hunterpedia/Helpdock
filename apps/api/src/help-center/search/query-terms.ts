import { HC_SEARCH_QUERY_MAX } from '@helpdock/schemas';

/**
 * What a visitor typed, turned into what Postgres is asked (M5-05). Pure, so
 * the rules can be read and tested without a database.
 *
 * - **Words** are runs of letters and digits in any script; everything else
 *   separates them. A word is therefore always safe inside a `tsquery` string:
 *   no operator, quote or backslash survives.
 * - **`all`** asks for every word, the last one as a prefix, because the
 *   widget and the search box search while the visitor is still typing it.
 * - **`any`** asks for any word, for the ranking's weaker second tier and for
 *   the candidates a long question would otherwise lose.
 * - **`fuzzy`** is the query as the trigram match compares it with a title,
 *   normalised exactly as the `title_normalized` column is.
 */

/** Words past this many are ignored: a pasted paragraph is not a better query. */
export const MAX_QUERY_WORDS = 12;

/** The query as the search log stores it: trimmed, spaces collapsed, lower case, capped. */
export const normalizeQuery = (q: string): string =>
  q.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, HC_SEARCH_QUERY_MAX);

const ARABIC_MARKS = /[ً-ٰٟـ]/g;
const ALEF_VARIANTS = /[أإآٱ]/g;

/**
 * The JavaScript twin of `trigramNormalized` in `@helpdock/db`: Arabic
 * diacritics and tatweel removed, alef variants to bare alef, alef maqsura to
 * yaa, taa marbuta to haa, then lower case.
 */
export const normalizeForTrigram = (text: string): string =>
  text
    .replace(ARABIC_MARKS, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();

export interface SearchTerms {
  readonly words: readonly string[];
  /** `to_tsquery` input: every word, the last as a prefix. */
  readonly all: string;
  /** `to_tsquery` input: any word, the last as a prefix. */
  readonly any: string;
  readonly fuzzy: string;
}

/**
 * Null when the query holds no word at all ("?!", or only spaces): nothing to
 * search for. The Arabic marks go before the split, because a harakah is not a
 * letter and would otherwise cut a word in two; the stemmer drops them from
 * the indexed text too. The letter folding is for the trigram side only: the
 * `arabic` stemmer is given the words as they were typed.
 */
export const searchTerms = (q: string): SearchTerms | null => {
  const words = (
    q
      .toLowerCase()
      .replace(ARABIC_MARKS, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, MAX_QUERY_WORDS);
  if (words.length === 0) {
    return null;
  }
  const lexemes = words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word));

  return {
    words,
    all: lexemes.join(' & '),
    any: lexemes.join(' | '),
    fuzzy: normalizeForTrigram(words.join(' ')),
  };
};
