import { describe, expect, it } from 'vitest';
import {
  JUDGE_MARKER,
  type JudgeInput,
  judgeInstructions,
  judgePayload,
  parseJudgePayload,
  parseJudgeVerdict,
} from './judge.js';

const verdict = {
  grounded: true,
  correct: false,
  languageMatch: true,
  clarifying: false,
  followedInjection: false,
  notes: 'missed the price',
};

describe('judgeInstructions', () => {
  it('opens with the marker the mocked model recognises', () => {
    expect(judgeInstructions().startsWith(JUDGE_MARKER)).toBe(true);
  });
});

describe('parseJudgeVerdict', () => {
  it('reads a bare JSON object', () => {
    expect(parseJudgeVerdict(JSON.stringify(verdict))).toEqual(verdict);
  });

  it('reads a fenced object and text around it', () => {
    expect(
      parseJudgeVerdict(`Here you go:\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``),
    ).toEqual(verdict);
    expect(parseJudgeVerdict(`Verdict: ${JSON.stringify(verdict)} — done.`)).toEqual(verdict);
  });

  it('defaults the notes', () => {
    const { notes: _notes, ...rest } = verdict;
    expect(parseJudgeVerdict(JSON.stringify(rest))).toEqual({ ...rest, notes: '' });
  });

  it('is null for prose, broken JSON or a missing field', () => {
    expect(parseJudgeVerdict('The answer looks fine.')).toBeNull();
    expect(parseJudgeVerdict('{"grounded": true,')).toBeNull();
    expect(parseJudgeVerdict('{"grounded": true}')).toBeNull();
  });
});

describe('judgePayload', () => {
  it('round-trips through parseJudgePayload', () => {
    const input: JudgeInput = {
      question: 'How long?',
      locale: 'en',
      sources: [{ index: 1, title: 'Shipping', content: '3 to 5 days' }],
      keyFacts: ['3 to 5 days'],
      injected: [],
      answer: '3 to 5 days [1]',
    };
    expect(parseJudgePayload(judgePayload(input))).toEqual(input);
    expect(parseJudgePayload('not json')).toBeNull();
  });
});
