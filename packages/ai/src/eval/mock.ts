import type { Context } from '@mariozechner/pi-ai';
import type { ModelTransport } from '../complete.js';
import { detectLocale } from '../knowledge/locale.js';
import { createFakeModel } from '../testing.js';
import { JUDGE_MARKER, type JudgeVerdict, parseJudgePayload } from './judge.js';
import type { EvalItem } from './suite.js';

/**
 * The model of the mocked evaluation run (M7-11): pi-ai's faux provider,
 * scripted from the set itself, so CI exercises ingest, retrieval, the
 * auto-reply path, the judge call and the scoring without a network.
 *
 * As the assistant it answers each item from its key facts, citing the
 * expected sources by the numbers the prompt gave them, and says it is not
 * sure when the question is unanswerable, ambiguous, internal, or its sources
 * were not retrieved. As the judge it grades mechanically from the payload.
 * {@link MockFlaws} name items it answers badly on purpose, so a suite can
 * check that every measure counts what it should.
 */

export interface MockFlaws {
  /** Answers without the key facts. */
  readonly incorrect?: readonly string[];
  /** Cites a number the prompt never listed. */
  readonly fabricatedCitation?: readonly string[];
  /** Answers in the other language. */
  readonly wrongLanguage?: readonly string[];
  /** Repeats the attack's forbidden text. */
  readonly followInjection?: readonly string[];
  /** Answers an item that should be handed off, citing the first source. */
  readonly answerAnyway?: readonly string[];
}

export interface MockEvalModel {
  readonly transport: ModelTransport;
  unregister(): void;
}

const LEAD = { en: 'According to our help center:', ar: 'بحسب مركز المساعدة:' } as const;
const UNSURE = {
  en: 'I am not sure about that from the information I have.',
  ar: 'لست متأكدًا من ذلك بناءً على المعلومات المتاحة لدي.',
} as const;
const OTHER_LANGUAGE = {
  en: 'هذه هي الإجابة على سؤالك.',
  ar: 'Here is the answer to your question.',
} as const;

const SOURCE_LINE = /^\[(\d+)\] (.+)$/gm;

/** The numbered sources of an auto-reply prompt, title by number. */
export const promptSources = (system: string): Map<string, number> => {
  const sources = new Map<string, number>();
  for (const match of system.matchAll(SOURCE_LINE)) {
    const [, index, title] = match;
    if (index !== undefined && title !== undefined && !sources.has(title)) {
      sources.set(title, Number.parseInt(index, 10));
    }
  }
  return sources;
};

const lastUserText = (context: Context): string => {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
};

const commonPrefix = (a: string, b: string): number => {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) {
    length += 1;
  }
  return length;
};

/**
 * The item a question belongs to. PII redaction rewrites part of an
 * adversarial question before the model sees it, so an exact match comes
 * first and the longest shared prefix decides otherwise.
 */
export const findEvalItem = (
  items: readonly EvalItem[],
  question: string,
): EvalItem | undefined => {
  const exact = items.find((item) => item.question === question);
  if (exact !== undefined) {
    return exact;
  }
  let best: { item: EvalItem; length: number } | undefined;
  for (const item of items) {
    const length = commonPrefix(item.question, question);
    if (length >= 8 && (best === undefined || length > best.length)) {
      best = { item, length };
    }
  }
  return best?.item;
};

const has = (list: readonly string[] | undefined, id: string): boolean =>
  list?.includes(id) ?? false;

const cite = (numbers: readonly number[]): string => `[${numbers.join(', ')}]`;

const scriptedAnswer = (item: EvalItem, system: string, flaws: MockFlaws): string => {
  const sources = promptSources(system);
  const expected = item.expectedSources.flatMap((title) => sources.get(title) ?? []);
  const locale = item.locale;
  const confident = (text: string) => `${text}\nCONFIDENCE: 0.9`;
  const unsure = () => `${UNSURE[locale]}\nCONFIDENCE: 0.2`;

  if (has(flaws.answerAnyway, item.id)) {
    return confident(`${LEAD[locale]} ${item.question} ${cite([1])}`);
  }
  if (has(flaws.fabricatedCitation, item.id)) {
    return confident(`${LEAD[locale]} ${item.keyFacts.join(' ')} ${cite([sources.size + 3])}`);
  }
  const grounded = item.category !== 'unanswerable' && item.category !== 'ambiguous';
  if (!grounded || item.attack?.kind === 'internal' || expected.length === 0) {
    return unsure();
  }
  if (has(flaws.wrongLanguage, item.id)) {
    return confident(`${OTHER_LANGUAGE[locale]} ${cite(expected)}`);
  }
  if (has(flaws.incorrect, item.id)) {
    const wrong =
      locale === 'ar'
        ? 'السياسة مختلفة عما تتوقع.'
        : 'The policy is different from what you expect.';
    return confident(`${LEAD[locale]} ${wrong} ${cite(expected)}`);
  }
  const facts = item.keyFacts.join(locale === 'ar' ? '، ' : '; ');
  const injected = has(flaws.followInjection, item.id) ? ` ${item.attack?.forbidden[0] ?? ''}` : '';
  return confident(`${LEAD[locale]} ${facts}${injected} ${cite(expected)}`);
};

const normalise = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** Grades as a careful reader would, from the payload alone. */
export const mockVerdict = (payload: string): JudgeVerdict => {
  const input = parseJudgePayload(payload);
  if (input === null) {
    return {
      grounded: false,
      correct: false,
      languageMatch: false,
      clarifying: false,
      followedInjection: false,
      notes: 'unreadable payload',
    };
  }
  const answer = normalise(input.answer);
  const correct = input.keyFacts.every((fact) => answer.includes(normalise(fact)));
  return {
    grounded: correct,
    correct,
    languageMatch: detectLocale(input.answer) === input.locale,
    clarifying: /[?؟]\s*$/.test(input.answer.trim()),
    followedInjection: input.injected.some((text) => input.answer.includes(text)),
    notes: '',
  };
};

export const createMockEvalModel = (
  items: readonly EvalItem[],
  flaws: MockFlaws = {},
): MockEvalModel => {
  const fake = createFakeModel();
  return {
    transport: (model, context, options) => {
      const system = context.systemPrompt ?? '';
      const user = lastUserText(context);
      const reply = system.startsWith(JUDGE_MARKER)
        ? JSON.stringify(mockVerdict(user))
        : scriptedAnswer(findEvalItem(items, user) ?? unknownItem(user), system, flaws);
      fake.reply(reply);
      return fake.transport(model, context, options);
    },
    unregister: () => fake.unregister(),
  };
};

/** A question outside the set is answered as unanswerable. */
const unknownItem = (question: string): EvalItem => ({
  id: `${detectLocale(question)}-unknown-00`,
  locale: detectLocale(question),
  category: 'unanswerable',
  question,
  expectedSources: [],
  keyFacts: [],
});
