/**
 * The language of a piece of knowledge, for the two things that depend on it:
 * the full-text configuration (`arabic` or `english`, the generated
 * `knowledge_chunks.search` column) and the locale boost of retrieval.
 *
 * Helpdock ships English and Arabic, so the question is only "is this Arabic?".
 * A chunk is Arabic when at least {@link ARABIC_SHARE} of its letters are in
 * the Arabic blocks; a support article in Arabic quotes product names, URLs
 * and error codes in Latin script, so a simple majority would misfile it.
 */

export type KnowledgeLocale = 'en' | 'ar';

export const ARABIC_SHARE = 0.3;

// Arabic, Arabic Supplement, Arabic Extended-A, and both presentation-form blocks.
const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u;
const LETTER = /\p{L}/u;

export const detectLocale = (text: string): KnowledgeLocale => {
  let letters = 0;
  let arabic = 0;
  for (const character of text) {
    if (LETTER.test(character)) {
      letters += 1;
      if (ARABIC_LETTER.test(character)) {
        arabic += 1;
      }
    }
  }
  return letters > 0 && arabic / letters >= ARABIC_SHARE ? 'ar' : 'en';
};
