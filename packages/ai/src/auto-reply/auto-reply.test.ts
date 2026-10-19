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

  it('reads a line padded with blanks, and a near miss of many blanks in linear time', () => {
    expect(readSelfAssessment('x\n\t confidence : 70 % \t').self).toBe(0.7);

    const started = performance.now();
    const nearMiss = `confidence:0${'\t'.repeat(100_000)}x`;
    expect(readSelfAssessment(nearMiss)).toEqual({ text: nearMiss, self: 0 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('reads a figure run on from the last sentence and removes it', () => {
    expect(readSelfAssessment('تواصل مع الدعم [1]. CONFIDENCE: 0.95')).toEqual({
      text: 'تواصل مع الدعم [1].',
      self: 0.95,
    });
  });

  it.each([
    ['Five days [1].\n**Confidence:** 0.9', 0.9],
    ['Five days [1].\n**CONFIDENCE: 0.9**', 0.9],
    ['Five days [1]. *confidence*: 0.9.', 0.9],
    ['Five days [1].\n\n  Confidence:0.9  \n', 0.9],
  ])('reads %j whatever its emphasis, case and blanks', (answer, self) => {
    expect(readSelfAssessment(answer)).toEqual({ text: 'Five days [1].', self });
  });

  it.each([
    'Ride with confidence: the frame is rated for 120 kg [1].',
    'Confidence: 0.9 is what we aim for, and refunds take 5 days [1].',
    'Overconfidence: 0.9',
    'Refunds take 5 days [1]. CONFIDENCE: high',
  ])('reads no confidence from a figure that is not the trailer, in %j', (answer) => {
    expect(readSelfAssessment(answer)).toEqual({ text: answer, self: 0 });
  });

  it('treats NO_ANSWER as nothing to send, whatever surrounds it', () => {
    expect(readSelfAssessment('NO_ANSWER')).toEqual({ text: '', self: 0 });
    expect(
      readSelfAssessment('Sorry, the sources say nothing [1].\nNO_ANSWER\nCONFIDENCE: 0.9'),
    ).toEqual({ text: '', self: 0 });
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

  it('hands off a NO_ANSWER, however confident the rest of the reply', () => {
    expect(
      decideAutoReply({
        ...input,
        answer: 'The sources only cover returns [1].\nNO_ANSWER\nCONFIDENCE: 0.95',
      }),
    ).toEqual({ kind: 'handoff', reason: 'low_confidence', confidence: 0 });
  });

  it('answers when the model ran its confidence on from the last sentence', () => {
    expect(decideAutoReply({ ...input, answer: 'Five days [1]. CONFIDENCE: 0.9' })).toMatchObject({
      kind: 'answer',
      text: 'Five days [1].',
      confidence: 0.9,
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
  it('numbers the sources and asks for the reader language, a confidence line and NO_ANSWER', () => {
    const instructions = autoReplyInstructions(
      [{ index: 1, title: 'Refund timelines', content: 'Card refunds take 3 to 5 days.' }],
      'ar',
    );
    expect(instructions).toContain('[1] Refund timelines\nCard refunds take 3 to 5 days.');
    expect(instructions).toContain('Reply in Arabic');
    expect(instructions).toContain('CONFIDENCE: ');
    expect(instructions).toContain('reply with only the word NO_ANSWER');
  });

  it('ends with an example reply the parser reads', () => {
    const instructions = autoReplyInstructions([], 'en');
    const example = instructions.slice(
      instructions.indexOf('For example:') + 'For example:'.length,
    );
    const [reply] = example.trim().split('\n\n');
    expect(readSelfAssessment(reply ?? '')).toEqual({
      text: 'Card refunds take 3 to 5 business days [1].',
      self: 0.9,
    });
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
