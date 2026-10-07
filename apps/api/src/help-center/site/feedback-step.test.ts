import { describe, expect, it } from 'vitest';
import { feedbackHref, feedbackStepOf, nextFeedbackStep } from './feedback-step.js';

describe('feedbackStepOf', () => {
  it.each([
    ['1', 'thanks'],
    ['no', 'comment'],
    [undefined, 'ask'],
    ['yes', 'ask'],
  ] as const)('reads ?feedback=%s as %s', (param, step) => {
    expect(feedbackStepOf(param)).toBe(step);
  });
});

describe('nextFeedbackStep', () => {
  it('asks what was missing after a first "No"', () => {
    expect(nextFeedbackStep({ helpful: 'no' })).toBe('comment');
  });

  it('thanks the reader for a "Yes", and for the comment step, sent empty or not', () => {
    expect(nextFeedbackStep({ helpful: 'yes' })).toBe('thanks');
    expect(nextFeedbackStep({ helpful: 'no', comment: '' })).toBe('thanks');
    expect(nextFeedbackStep({ helpful: 'no', comment: 'Apple Pay' })).toBe('thanks');
  });
});

describe('feedbackHref', () => {
  it('round-trips each step through the article address', () => {
    const comment = feedbackHref('/hc/b/en/articles/refunds', 'comment');
    const thanks = feedbackHref('/hc/b/en/articles/refunds', 'thanks');

    expect(comment).toBe('/hc/b/en/articles/refunds?feedback=no#hd-feedback-comment');
    expect(feedbackStepOf(new URL(thanks, 'https://x').searchParams.get('feedback') ?? '')).toBe(
      'thanks',
    );
  });
});
