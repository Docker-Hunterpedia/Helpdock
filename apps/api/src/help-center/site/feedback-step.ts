import type { HcFeedbackForm } from '@helpdock/schemas';

/**
 * Where an article's "Was this helpful?" card stands (M5-08,
 * `HelpCenter/Article-AR`): asking, the optional "What was missing?" after a
 * first "No", or thanking. The page has no script, so the step travels in the
 * article's `?feedback=` after each post; only the asking page is cached.
 */
export type FeedbackStep = 'ask' | 'comment' | 'thanks';

const PARAM: Readonly<Record<Exclude<FeedbackStep, 'ask'>, string>> = {
  comment: 'no',
  thanks: '1',
};

export const feedbackStepOf = (param: string | undefined): FeedbackStep => {
  if (param === PARAM.thanks) {
    return 'thanks';
  }
  return param === PARAM.comment ? 'comment' : 'ask';
};

/** A first "No" asks what was missing; a "Yes", or the comment step's form, is answered. */
export const nextFeedbackStep = (
  form: Pick<HcFeedbackForm, 'helpful' | 'comment'>,
): Exclude<FeedbackStep, 'ask'> =>
  form.helpful === 'no' && form.comment === undefined ? 'comment' : 'thanks';

/**
 * Where each step's address points: the note's field, which the browser then
 * focuses (it skips `autofocus` on a page opened at a fragment), and the
 * thanks, which takes focus as a `tabindex="-1"` status line.
 */
export const FEEDBACK_TARGET: Readonly<Record<Exclude<FeedbackStep, 'ask'>, string>> = {
  comment: 'hd-feedback-comment',
  thanks: 'feedback',
};

/** The article's address at a step, scrolled to it and focusing it. */
export const feedbackHref = (articleHref: string, step: Exclude<FeedbackStep, 'ask'>): string =>
  `${articleHref}?feedback=${PARAM[step]}#${FEEDBACK_TARGET[step]}`;
