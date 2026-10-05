import type { AssistCitation, SuggestReplyResult } from '@helpdock/schemas';

/**
 * The pure halves of agent assist's screens (M7-05, M7-09): how a cost is
 * written, which language a text is in, and what "Insert" puts in the reply.
 */

/** `$0.0031`: the four decimals the AI log draws, in Latin digits in both locales. */
export const formatUsd = (value: number): string => `$${value.toFixed(4)}`;

// The Arabic blocks, as `detectLocale` in `@helpdock/ai` reads them.
const ARABIC_LETTER = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u;
const LETTER = /\p{L}/u;

/** `ar` when at least 30 % of the letters are Arabic, as the api decides it. */
export const textLocale = (text: string): 'en' | 'ar' => {
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
  return letters > 0 && arabic / letters >= 0.3 ? 'ar' : 'en';
};

const markersOf = (citations: readonly AssistCitation[], visibility: 'public' | 'internal') =>
  new Set(
    citations
      .filter((citation) => citation.visibility === visibility)
      .map((citation) => citation.marker),
  );

/**
 * What "Insert" puts in the composer. A public reply loses every internal
 * citation — DOMAIN-RULES §5: "the insert into reply action strips internal
 * citations" — and gains a sources line for the public ones, so a `[1]` the
 * customer reads points somewhere. A note keeps everything.
 */
export const insertableReply = (
  suggestion: Pick<SuggestReplyResult, 'text' | 'citations'>,
  mode: 'reply' | 'note',
): string => {
  if (mode === 'note') {
    return suggestion.text;
  }
  const internal = markersOf(suggestion.citations, 'internal');
  const text = suggestion.text
    .replace(/\[(\s*\d+\s*(?:,\s*\d+\s*)*)\]/g, (_, group: string) => {
      const kept = group
        .split(',')
        .map((marker) => Number.parseInt(marker.trim(), 10))
        .filter((marker) => !internal.has(marker));
      return kept.length === 0 ? '' : `[${kept.join(', ')}]`;
    })
    .replace(/[ \t]+([.,;:!?؟،])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const sources = suggestion.citations
    .filter((citation) => citation.visibility === 'public' && citation.url !== null)
    .map((citation) => `[${String(citation.marker)}] ${citation.title}: ${String(citation.url)}`);
  return sources.length === 0 ? text : `${text}\n\n${sources.join('\n')}`;
};

/** Splits a redacted text into plain runs and `[EMAIL_1]`-style placeholders. */
export const redactionParts = (
  text: string,
): readonly { readonly text: string; readonly placeholder: boolean }[] =>
  text
    .split(/(\[(?:EMAIL|PHONE|CARD|IBAN)_\d+\])/)
    .filter((part) => part !== '')
    .map((part) => ({ text: part, placeholder: /^\[(?:EMAIL|PHONE|CARD|IBAN)_\d+\]$/.test(part) }));
