/**
 * The instructions agent assist and triage send (M7-05, M7-07), one builder
 * per task (ARCHITECTURE §10, `tasks/`). They are the feature's own
 * instructions, which `complete()` places before the brand's system prompt;
 * the ticket goes in as the user message, so the brand's tone and forbidden
 * topics still apply on top.
 *
 * Every builder that asks for structure asks for one JSON object and nothing
 * else, and the parsers in `answers.ts` read it leniently: a model that wraps
 * it in a code fence or a sentence is still understood.
 */

export type AssistLocale = 'en' | 'ar';

/** Who wrote a line of the thread, as the model is told. */
export type ThreadRole = 'customer' | 'agent' | 'assistant' | 'note';

export interface ThreadLine {
  readonly role: ThreadRole;
  readonly text: string;
}

const LABEL: Readonly<Record<ThreadRole, string>> = {
  customer: 'Customer',
  agent: 'Agent',
  assistant: 'Assistant',
  note: 'Internal note',
};

/** A thread as the model reads it: one labelled block per message, oldest first. */
export const formatThread = (lines: readonly ThreadLine[]): string =>
  lines.map((line) => `${LABEL[line.role]}:\n${line.text.trim()}`).join('\n\n');

const LANGUAGE: Readonly<Record<AssistLocale, string>> = { en: 'English', ar: 'Arabic' };

const KEEP_PLACEHOLDERS =
  'Text like [EMAIL_1] or [CARD_1] stands for personal data that was removed; copy such placeholders exactly where they are needed and never guess what they hide.';

export interface KnowledgeExcerpt {
  readonly index: number;
  readonly title: string;
  readonly content: string;
}

/** The retrieved chunks, numbered as the model must cite them. */
export const formatKnowledge = (excerpts: readonly KnowledgeExcerpt[]): string =>
  excerpts.length === 0
    ? 'Knowledge: none was found for this ticket.'
    : `Knowledge:\n${excerpts.map((excerpt) => `[${String(excerpt.index)}] ${excerpt.title}\n${excerpt.content.trim()}`).join('\n\n')}`;

export const suggestReplyInstructions = (locale: AssistLocale): string =>
  [
    'You draft the next reply an agent of a support team sends to the customer in the ticket below.',
    `Write it in ${LANGUAGE[locale]}, as plain text, ready to send: a greeting, the answer, no signature.`,
    'Answer only from the numbered knowledge excerpts and what the thread itself says. Cite every excerpt you rely on with its number in square brackets, such as [1], right after the sentence that uses it.',
    'If the knowledge does not answer the question, say what the agent should check instead of inventing an answer.',
    KEEP_PLACEHOLDERS,
  ].join('\n');

export const summarizeInstructions = (locale: AssistLocale): string =>
  [
    'Summarise the support ticket below for an agent who is about to take it over.',
    `Answer in ${LANGUAGE[locale]} with a JSON object {"points": [...]} of two to five short sentences: what the customer wants, what has been done, and what is still open.`,
    KEEP_PLACEHOLDERS,
  ].join('\n');

export interface ClassifyOptions {
  readonly tags: readonly { readonly id: string; readonly name: string }[];
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  readonly fields: readonly ('tags' | 'priority' | 'department')[];
}

/**
 * Triage and "Suggest tags, priority, department": the model may only choose
 * among the brand's own tags and departments, by id, so an answer naming
 * anything else is discarded rather than created.
 */
export const classifyInstructions = ({ tags, departments, fields }: ClassifyOptions): string => {
  const wanted: string[] = [];
  if (fields.includes('tags')) {
    wanted.push(
      `"tagIds": up to three ids from this list that fit the ticket, or []:\n${tags.map((tag) => `- ${tag.id}: ${tag.name}`).join('\n') || '- (the brand has no tags)'}`,
    );
  }
  if (fields.includes('priority')) {
    wanted.push('"priority": one of "low", "medium", "high", "urgent"');
  }
  if (fields.includes('department')) {
    wanted.push(
      `"departmentId": the id of the department that should handle it, from this list:\n${departments.map((department) => `- ${department.id}: ${department.name}`).join('\n')}`,
    );
  }
  return [
    'You classify a support ticket for routing.',
    `Answer with one JSON object and nothing else, with these keys:\n${wanted.join('\n')}`,
    'Use only the ids listed. Use null for a value you cannot decide.',
  ].join('\n');
};

export const translateInstructions = (target: AssistLocale): string =>
  [
    `Translate the text below into ${LANGUAGE[target]}.`,
    'Answer with the translation alone, keeping its line breaks, names, numbers and anything in square brackets unchanged.',
  ].join('\n');

export type RewriteTone = 'friendlier' | 'formal' | 'shorter';

const TONE: Readonly<Record<RewriteTone, string>> = {
  friendlier: 'warmer and friendlier, still professional',
  formal: 'more formal and polished',
  shorter: 'shorter, keeping every fact and commitment',
};

export const rewriteInstructions = (tone: RewriteTone): string =>
  [
    `Rewrite the agent's draft reply below to be ${TONE[tone]}.`,
    'Keep its language, its facts, dates and amounts. Answer with the rewritten reply alone, as plain text.',
    KEEP_PLACEHOLDERS,
  ].join('\n');

export const draftArticleInstructions = (locale: AssistLocale): string =>
  [
    'Turn the support conversation below into a help center article other customers can read.',
    `Write it in ${LANGUAGE[locale]} as general advice: no names, no order numbers, nothing about this one customer, and never a placeholder like [EMAIL_1].`,
    'Answer with one JSON object and nothing else: {"title": "...", "body": "..."}. The body uses paragraphs separated by blank lines, "## " headings and "- " bullet points, and nothing else.',
    'Where the numbered knowledge excerpts back a statement, you may cite them as [1].',
  ].join('\n');
