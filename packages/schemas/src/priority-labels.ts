import { z } from 'zod';
import type { TicketPriority } from './ticket.js';

/**
 * Editable priority labels (M1-02).
 *
 * A brand renames its four priorities for its own staff; the api value stays
 * `low | medium | high | urgent` in rules, SLAs, imports, webhooks, reports and
 * the public API. The names are display-only, one per interface language, and
 * an empty name means "use the default", so an override is never stored empty.
 */

/**
 * Spelled out rather than read from `ticketPrioritySchema`: `ticket.ts` reaches
 * `brand.ts` through `csat.ts`, and `brand.ts` imports this file, so importing
 * the schema here would be a cycle. A test keeps the two lists equal.
 */
export const PRIORITY_KEYS: readonly TicketPriority[] = ['low', 'medium', 'high', 'urgent'];

export const PRIORITY_LABEL_LOCALES = ['en', 'ar'] as const;
export type PriorityLabelLocale = (typeof PRIORITY_LABEL_LOCALES)[number];

export const PRIORITY_LABEL_MAX_LENGTH = 24;

/**
 * The catalog names (`tickets:priority.*`). Held here because the api checks
 * uniqueness against them and apps never import each other; a test in the admin
 * app keeps them equal to the catalogs.
 */
export const DEFAULT_PRIORITY_NAMES: Readonly<
  Record<PriorityLabelLocale, Readonly<Record<TicketPriority, string>>>
> = {
  en: { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' },
  ar: { low: 'منخفضة', medium: 'متوسطة', high: 'عالية', urgent: 'عاجلة' },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** One name as typed: trimmed, 1 to 24 characters, one line. */
export const priorityLabelNameSchema = z
  .string()
  .trim()
  .min(1, 'Use 1 to 24 characters')
  .max(PRIORITY_LABEL_MAX_LENGTH, 'Use 1 to 24 characters')
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Use one line without control characters');

const priorityLabelRowSchema = z.object({
  en: priorityLabelNameSchema.optional(),
  ar: priorityLabelNameSchema.optional(),
});
export type PriorityLabelRow = z.infer<typeof priorityLabelRowSchema>;

const priorityLabelShape = {
  low: priorityLabelRowSchema.optional(),
  medium: priorityLabelRowSchema.optional(),
  high: priorityLabelRowSchema.optional(),
  urgent: priorityLabelRowSchema.optional(),
};

export type PriorityLabels = Partial<Record<TicketPriority, PriorityLabelRow>>;

/** Names as a form or request holds them: any of them may be missing or empty. */
export type PriorityLabelsInput = {
  [K in TicketPriority]?: { en?: string | undefined; ar?: string | undefined } | undefined;
};

/** The name a priority shows in one language: the override, else the default. */
export const effectivePriorityName = (
  labels: PriorityLabelsInput | undefined,
  priority: TicketPriority,
  locale: PriorityLabelLocale,
): string => labels?.[priority]?.[locale] ?? DEFAULT_PRIORITY_NAMES[locale][priority];

export interface PriorityLabelConflict {
  readonly priority: TicketPriority;
  readonly locale: PriorityLabelLocale;
  /** The other priority that already has this name in this language. */
  readonly takenBy: TicketPriority;
}

/**
 * Two priorities may not share a name within one language, compared without
 * case, counting the default of every priority left empty. Returns each
 * priority that collides with an earlier one in the fixed order.
 */
export const priorityLabelConflicts = (
  labels: PriorityLabelsInput | undefined,
): PriorityLabelConflict[] => {
  const conflicts: PriorityLabelConflict[] = [];

  for (const locale of PRIORITY_LABEL_LOCALES) {
    const seen = new Map<string, TicketPriority>();
    for (const priority of PRIORITY_KEYS) {
      const key = effectivePriorityName(labels, priority, locale).toLocaleLowerCase(locale);
      const owner = seen.get(key);
      if (owner === undefined) {
        seen.set(key, priority);
        continue;
      }
      // The renamed row is the one that changed, so the error lands there.
      const renamed = labels?.[priority]?.[locale] !== undefined ? priority : owner;
      conflicts.push({
        priority: renamed,
        locale,
        takenBy: renamed === priority ? owner : priority,
      });
    }
  }

  return conflicts;
};

const withUniqueNames = (labels: PriorityLabelsInput, context: z.RefinementCtx): void => {
  for (const conflict of priorityLabelConflicts(labels)) {
    context.addIssue({
      code: 'custom',
      message: `Already used by ${conflict.takenBy}`,
      path: [conflict.priority, conflict.locale],
    });
  }
};

/** What a brand stores: only the names it changed. */
export const priorityLabelsSchema = z.object(priorityLabelShape).superRefine(withUniqueNames);

const priorityLabelDraftNameSchema = z
  .string()
  .trim()
  .refine((value) => value === '' || !CONTROL_CHARACTERS.test(value), 'Use one line')
  .refine(
    (value) => value.length <= PRIORITY_LABEL_MAX_LENGTH,
    `Use up to ${PRIORITY_LABEL_MAX_LENGTH} characters`,
  );

const priorityLabelDraftRowSchema = z.object({
  en: priorityLabelDraftNameSchema.optional(),
  ar: priorityLabelDraftNameSchema.optional(),
});

/**
 * The full four-row map `PUT .../priority-labels` replaces the stored value
 * with. An empty or missing name means "the default" and is dropped by
 * {@link compactPriorityLabels}, which is how a reset is written.
 */
export const priorityLabelsUpdateRequestSchema = z
  .object({
    low: priorityLabelDraftRowSchema.optional(),
    medium: priorityLabelDraftRowSchema.optional(),
    high: priorityLabelDraftRowSchema.optional(),
    urgent: priorityLabelDraftRowSchema.optional(),
  })
  .superRefine((value, context) => {
    withUniqueNames(compactPriorityLabels(value), context);
  });
export type PriorityLabelsUpdateRequest = z.infer<typeof priorityLabelsUpdateRequestSchema>;

/** Drops empty names and then empty rows. */
export const compactPriorityLabels = (value: PriorityLabelsInput): PriorityLabels => {
  const result: PriorityLabels = {};

  for (const priority of PRIORITY_KEYS) {
    const row: PriorityLabelRow = {};
    for (const locale of PRIORITY_LABEL_LOCALES) {
      const name = value[priority]?.[locale]?.trim();
      if (name !== undefined && name !== '') {
        row[locale] = name;
      }
    }
    if (Object.keys(row).length > 0) {
      result[priority] = row;
    }
  }

  return result;
};
