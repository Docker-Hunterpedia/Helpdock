import { describe, expect, it } from 'vitest';
import { LOCALE_BOOST, RRF_K } from '../knowledge/fusion.js';
import { answerConfidence, readSelfAssessment, retrievalSupport } from './confidence.js';
import { decideAutoReply } from './decide.js';
import { asksForHuman } from './human-request.js';
import { autoReplyInstructions, autoReplyMessages } from './prompt.js';

const TOP_LEXICAL = 1 / (RRF_K + 1);
const chunk = (chunkId: string, score = TOP_LEXICAL, locale = 'fr') => ({ chunkId, score, locale });
const A = '00000000-0000-7000-8000-00000000000a';
const B = '00000000-0000-7000-8000-00000000000b';

describe('readSelfAssessment', () => {
  it('reads the last confidence line and removes it from the answer', () => {
    expect(readSelfAssessment('Refunds take 5 days [1].\nCONFIDENCE: 0.82')).toEqual({
      text: 'Refunds take 5 days [1].',
      self: 0.82,
    });
  });

  it('reads a percentage and a decimal comma', () => {
    expect(readSelfAssessment('x\nConfidence: 85%').self).toBe(0.85);
    expect(readSelfAssessment('x\nconfidence: 0,4').self).toBe(0.4);
  });

  it('counts a missing line as no confidence at all', () => {
    expect(readSelfAssessment('Refunds take 5 days [1].').self).toBe(0);
  });
});

describe('retrievalSupport', () => {
  it('is 1 for a chunk first in every ranker that ran, with or without the locale boost', () => {
    expect(retrievalSupport([chunk(A)], { rankers: 1, locale: 'en' })).toBe(1);
    expect(
      retrievalSupport([chunk(A, TOP_LEXICAL * LOCALE_BOOST, 'en')], { rankers: 1, locale: 'en' }),
    ).toBe(1);
  });

  it('is about a half for a chunk only one of two rankers found', () => {
    expect(retrievalSupport([chunk(A)], { rankers: 2, locale: 'en' })).toBeCloseTo(0.5);
  });

  it('is 0 when nothing was cited', () => {
    expect(retrievalSupport([], { rankers: 2, locale: 'en' })).toBe(0);
  });
});

describe('answerConfidence', () => {
  it('lowers the model figure by at most 40 % for weak retrieval', () => {
    expect(answerConfidence(1, 0, true)).toBe(0.6);
    expect(answerConfidence(0.95, 0.5, true)).toBe(0.76);
  });

  it('is 0 for an answer that cites nothing', () => {
    expect(answerConfidence(1, 1, false)).toBe(0);
  });
});

describe('decideAutoReply', () => {
  const input = {
    chunks: [chunk(A), chunk(B)],
    mode: 'lexical' as const,
    locale: 'en',
    threshold: 0.7,
  };

  it('answers with the citations when it is sure enough', () => {
    const decision = decideAutoReply({ ...input, answer: 'Five days [1].\nCONFIDENCE: 0.9' });
    expect(decision).toEqual({
      kind: 'answer',
      text: 'Five days [1].',
      citations: [{ marker: 1, chunkId: A }],
      confidence: 0.9,
    });
  });

  it('hands off below the threshold', () => {
    expect(decideAutoReply({ ...input, answer: 'Maybe [1].\nCONFIDENCE: 0.4' })).toEqual({
      kind: 'handoff',
      reason: 'low_confidence',
      confidence: 0.4,
    });
  });

  it('hands off when the answer cites a source it was not given', () => {
    expect(decideAutoReply({ ...input, answer: 'Yes [1] [7].\nCONFIDENCE: 0.99' })).toMatchObject({
      kind: 'handoff',
      reason: 'invalid_citation',
    });
  });

  it('hands off an answer that cites nothing, however sure the model says it is', () => {
    expect(decideAutoReply({ ...input, answer: 'Five days.\nCONFIDENCE: 1' })).toMatchObject({
      kind: 'handoff',
      reason: 'low_confidence',
      confidence: 0,
    });
  });
});

describe('asksForHuman', () => {
  it.each([
    'Can I talk to a human?',
    'I want to speak with someone about this',
    'connect me to an agent please',
    'human',
    'Agent please!',
    'أريد التحدث مع موظف',
    'ممكن اكلم شخص؟',
    'خدمة العملاء',
    'أريد موظفاً',
  ])('hears a request for a person in %j', (text) => {
    expect(asksForHuman(text)).toBe(true);
  });

  it.each([
    'The agent said my refund was issued',
    'How long does a refund take?',
    'كم يستغرق الاسترداد؟',
  ])('does not hear one in %j', (text) => {
    expect(asksForHuman(text)).toBe(false);
  });
});

describe('the prompt', () => {
  it('numbers the sources and asks for the reader language and a confidence line', () => {
    const instructions = autoReplyInstructions(
      [{ index: 1, title: 'Refund timelines', content: 'Card refunds take 3 to 5 days.' }],
      'ar',
    );
    expect(instructions).toContain('[1] Refund timelines\nCard refunds take 3 to 5 days.');
    expect(instructions).toContain('Reply in Arabic');
    expect(instructions).toContain('CONFIDENCE: ');
  });

  it('keeps the newest turns and ends with the customer', () => {
    const turns = Array.from({ length: 10 }, (_, index) => ({
      from: index % 2 === 0 ? ('assistant' as const) : ('customer' as const),
      text: String(index),
    }));
    const messages = autoReplyMessages(turns);
    expect(messages).toHaveLength(8);
    expect(messages.at(-1)).toEqual({ role: 'user', text: '9' });
  });
});
