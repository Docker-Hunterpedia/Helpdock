import { z } from 'zod';

/**
 * Reading what the model answered for the tasks that ask for JSON (M7-05,
 * M7-07). Models wrap JSON in a code fence or a sentence often enough that
 * the first `{` to the last `}` is taken; anything that still does not parse
 * against the task's schema is an {@link UnreadableAnswerError}, which the
 * caller reports instead of guessing.
 */

export class UnreadableAnswerError extends Error {
  constructor(task: string) {
    super(`The model's answer to ${task} could not be read`);
    this.name = 'UnreadableAnswerError';
  }
}

const jsonObjectIn = (answer: string): unknown => {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

const readJson = <T>(task: string, schema: z.ZodType<T>, answer: string): T => {
  const parsed = schema.safeParse(jsonObjectIn(answer));
  if (!parsed.success) {
    throw new UnreadableAnswerError(task);
  }
  return parsed.data;
};

const summarySchema = z.object({
  points: z
    .array(z.string())
    .transform((points) => points.map((point) => point.trim()).filter((point) => point !== ''))
    .pipe(z.array(z.string()).min(1).max(8)),
});

export const readSummary = (answer: string): readonly string[] =>
  readJson('summarize', summarySchema, answer).points;

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Classification {
  readonly tagIds: readonly string[];
  readonly priority: Priority | null;
  readonly departmentId: string | null;
}

const classificationSchema = z.object({
  tagIds: z.array(z.string()).nullish(),
  priority: z.string().nullish(),
  departmentId: z.string().nullish(),
});

/**
 * Keeps only what the brand has: a tag or department id the model was not
 * offered is dropped, never created, and so is a priority that is not one.
 */
export const readClassification = (
  answer: string,
  allowed: { readonly tagIds: readonly string[]; readonly departmentIds: readonly string[] },
): Classification => {
  const raw = readJson('classify', classificationSchema, answer);
  const priority = PRIORITIES.find((candidate) => candidate === raw.priority) ?? null;
  return {
    tagIds: [...new Set(raw.tagIds ?? [])].filter((id) => allowed.tagIds.includes(id)).slice(0, 3),
    priority,
    departmentId:
      raw.departmentId !== undefined &&
      raw.departmentId !== null &&
      allowed.departmentIds.includes(raw.departmentId)
        ? raw.departmentId
        : null,
  };
};

const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1),
});

export interface ArticleDraft {
  readonly title: string;
  readonly body: string;
}

export const readArticleDraft = (answer: string): ArticleDraft =>
  readJson('draft an article', draftSchema, answer);
