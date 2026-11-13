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
/** Zero-width, bidi-control and other format characters: invisible, so two names could look alike. */
const FORMAT_CHARACTERS = /\p{Cf}/u;

/** A name as it is stored: trimmed, in Unicode normal form C. */
export const normalisePriorityName = (value: string): string => value.trim().normalize('NFC');

/**
 * Whether a typed name (not empty) may be stored: 1 to 24 characters on one
 * line, with no control or invisible format characters. Shared by the form and
 * the api, so the two cannot disagree.
 */
export const isValidPriorityName = (value: string): boolean => {
  const name = normalisePriorityName(value);

  return (
    name.length >= 1 &&
    name.length <= PRIORITY_LABEL_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(name) &&
    !FORMAT_CHARACTERS.test(name)
  );
};

/** One name as typed; the stored form is {@link normalisePriorityName}. */
export const priorityLabelNameSchema = z
  .string()
  .refine(
    isValidPriorityName,
    'Use 1 to 24 visible characters on one line, without control or invisible characters',
  );

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

/**
 * What two names are compared by: compatibility-normalised (so a full-width or
 * decomposed spelling matches), without Arabic tatweel and vowel marks, then
 * lower-cased. "عاجلة" and "عــاجِلة" are the same name.
 */
export const uniquenessKey = (name: string, locale: PriorityLabelLocale): string =>
  name
    .normalize('NFKC')
    .replace(/[\u0640\u064B-\u065F\u0670]/gu, '')
    .toLocaleLowerCase(locale);

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
      const key = uniquenessKey(effectivePriorityName(labels, priority, locale), locale);
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
  .refine(
    (value) => value.trim() === '' || isValidPriorityName(value),
    'Use 1 to 24 visible characters on one line, without control or invisible characters',
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
      const name = value[priority]?.[locale];
      if (name === undefined) {
        continue;
      }
      const stored = normalisePriorityName(name);
      if (stored !== '') {
        row[locale] = stored;
      }
    }
    if (Object.keys(row).length > 0) {
      result[priority] = row;
    }
  }

  return result;
};
