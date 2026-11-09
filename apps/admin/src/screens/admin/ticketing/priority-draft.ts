import {
  compactPriorityLabels,
  DEFAULT_PRIORITY_NAMES,
  PRIORITY_KEYS,
  PRIORITY_LABEL_LOCALES,
  type PriorityLabelLocale,
  type PriorityLabelsInput,
  type PriorityLabelsUpdateRequest,
  priorityLabelConflicts,
  type TicketPriority,
} from '@helpdock/schemas';

/**
 * The form of the Priorities page (M1-02): what is typed in the eight fields,
 * kept as the person typed it so a refused save never loses it, and the pure
 * rules around it. Nothing here touches React.
 */

export type PriorityDraft = Record<TicketPriority, Record<PriorityLabelLocale, string>>;

/** `high.en`, the path the api reports a field by and the key of the page's refs. */
export interface FieldKey {
  readonly priority: TicketPriority;
  readonly locale: PriorityLabelLocale;
}

export const fieldPath = ({ priority, locale }: FieldKey): string => `${priority}.${locale}`;

/** Every field in reading order: each priority's English field, then its Arabic one. */
export const FIELD_ORDER: readonly FieldKey[] = PRIORITY_KEYS.flatMap((priority) =>
  PRIORITY_LABEL_LOCALES.map((locale) => ({ priority, locale })),
);

export const draftOf = (stored: PriorityLabelsInput | undefined): PriorityDraft =>
  Object.fromEntries(
    PRIORITY_KEYS.map((priority) => [
      priority,
      { en: stored?.[priority]?.en ?? '', ar: stored?.[priority]?.ar ?? '' },
    ]),
  ) as PriorityDraft;

/** The draft as the api will store it: trimmed, with empty names and rows dropped. */
export const overridesOf = (draft: PriorityDraft): PriorityLabelsInput =>
  compactPriorityLabels(draft);

/** Whether Save and Discard have something to do: what would be stored differs from what is. */
export const isDirty = (draft: PriorityDraft, stored: PriorityLabelsInput | undefined): boolean =>
  JSON.stringify(overridesOf(draft)) !== JSON.stringify(compactPriorityLabels(stored ?? {}));

export const hasOverride = (draft: PriorityDraft, priority: TicketPriority): boolean =>
  PRIORITY_LABEL_LOCALES.some((locale) => draft[priority][locale].trim() !== '');

export const withField = (draft: PriorityDraft, key: FieldKey, value: string): PriorityDraft => ({
  ...draft,
  [key.priority]: { ...draft[key.priority], [key.locale]: value },
});

/** Clears both names of a row. It still needs Save, like every other change. */
export const resetRow = (draft: PriorityDraft, priority: TicketPriority): PriorityDraft => ({
  ...draft,
  [priority]: { en: '', ar: '' },
});

export const toRequest = (draft: PriorityDraft): PriorityLabelsUpdateRequest => overridesOf(draft);

/** What the pill of a row says in the interface language: the typed name, else the default. */
export const pillName = (
  draft: PriorityDraft,
  priority: TicketPriority,
  locale: PriorityLabelLocale,
): string => draft[priority][locale].trim() || DEFAULT_PRIORITY_NAMES[locale][priority];

/** "Default: High" shows under a pill only while the pill is not the default. */
export const showsDefault = (
  draft: PriorityDraft,
  priority: TicketPriority,
  locale: PriorityLabelLocale,
): boolean => draft[priority][locale].trim() !== '';

export interface FieldIssue {
  readonly key: FieldKey;
  /** The other priority that already has this name in this language. */
  readonly takenBy: TicketPriority;
}

/**
 * The duplicate names, each placed on one field. When the field edited last is
 * one of the two that collide, the error is on it: it is what the person just
 * did. Otherwise it is on the field the shared rule names.
 */
export const duplicateIssues = (draft: PriorityDraft, lastEdited: FieldKey | null): FieldIssue[] =>
  priorityLabelConflicts(overridesOf(draft)).map((conflict) => {
    const editedHere =
      lastEdited !== null &&
      lastEdited.locale === conflict.locale &&
      (lastEdited.priority === conflict.priority || lastEdited.priority === conflict.takenBy);
    const priority = editedHere ? lastEdited.priority : conflict.priority;

    return {
      key: { priority, locale: conflict.locale },
      takenBy: priority === conflict.priority ? conflict.takenBy : conflict.priority,
    };
  });

/** The first of the given fields in reading order, which is where Save puts focus. */
export const firstInvalid = (keys: readonly FieldKey[]): FieldKey | undefined => {
  const paths = new Set(keys.map(fieldPath));

  return FIELD_ORDER.find((candidate) => paths.has(fieldPath(candidate)));
};
