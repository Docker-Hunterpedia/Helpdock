import type { CustomFieldDef, CustomFieldType, TicketFieldFilter } from '@helpdock/schemas';
import { FIELD_FILTER_TEXT_MAX, ticketFieldFilterSchema } from '@helpdock/schemas';

/**
 * A custom-field filter while somebody is still building it (M14-16): the
 * row of `Admin/Ticketing-FieldFilters` before it is complete. A row with an
 * operator and no value is a draft, not a filter, so the list never asks the
 * api for it.
 *
 * Kept flat, with every input's text, so switching the operator does not lose
 * what was typed into a box the new operator also shows.
 */
export type FieldFilterOp = TicketFieldFilter['op'];

export interface FieldFilterDraft {
  readonly key: string;
  readonly op: FieldFilterOp;
  /** `any_of`: the options chosen. */
  readonly values: readonly string[];
  /** `before`, `after` and `contains`: the box's text. `between`: the lower bound. */
  readonly text: string;
  /** `between`: the upper bound. */
  readonly to: string;
  /** `is`: ticked or not. */
  readonly flag: boolean;
}

/** The operators each type answers, the first being the one a new row starts on. */
const OPERATORS: Readonly<Record<CustomFieldType, readonly FieldFilterOp[]>> = {
  select: ['any_of', 'not_set'],
  multi_select: ['any_of', 'not_set'],
  checkbox: ['is', 'not_set'],
  number: ['between', 'before', 'after', 'not_set'],
  date: ['between', 'before', 'after', 'not_set'],
  text: ['contains', 'not_set'],
  long_text: ['contains', 'not_set'],
  link: ['contains', 'not_set'],
  email: ['contains', 'not_set'],
  person: ['any_of', 'not_set'],
};

export const operatorsOf = (type: CustomFieldType): readonly FieldFilterOp[] => OPERATORS[type];

export const blankDraft = (def: Pick<CustomFieldDef, 'key' | 'type'>): FieldFilterDraft => ({
  key: def.key,
  op: OPERATORS[def.type][0] ?? 'not_set',
  values: [],
  text: '',
  to: '',
  flag: true,
});

const asText = (bound: number | string): string => String(bound);

export const draftOfFilter = (filter: TicketFieldFilter): FieldFilterDraft => {
  const base = { ...blankDraft({ key: filter.key, type: 'text' }), key: filter.key, op: filter.op };
  switch (filter.op) {
    case 'any_of':
      return { ...base, values: filter.values };
    case 'is':
      return { ...base, flag: filter.value };
    case 'before':
    case 'after':
      return { ...base, text: asText(filter.value) };
    case 'between':
      return { ...base, text: asText(filter.from), to: asText(filter.to) };
    case 'contains':
      return { ...base, text: filter.value };
    case 'not_set':
      return base;
  }
};

/** A bound as the type carries it: a number for a number field, a day for a date. */
const boundOf = (type: CustomFieldType, text: string): number | string | null => {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  if (type === 'number') {
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  }

  return trimmed;
};

/**
 * The filter a draft stands for, or `null` while it is incomplete or the api's
 * own schema would refuse it (a range that ends before it starts, a day that
 * is not one). The schema is the api's, so the two cannot disagree.
 */
export const filterOfDraft = (
  draft: FieldFilterDraft,
  type: CustomFieldType,
): TicketFieldFilter | null => {
  const candidate = (() => {
    switch (draft.op) {
      case 'any_of':
        return { key: draft.key, op: 'any_of', values: [...draft.values] };
      case 'not_set':
        return { key: draft.key, op: 'not_set' };
      case 'is':
        return { key: draft.key, op: 'is', value: draft.flag };
      case 'before':
      case 'after':
        return { key: draft.key, op: draft.op, value: boundOf(type, draft.text) };
      case 'between':
        return {
          key: draft.key,
          op: 'between',
          from: boundOf(type, draft.text),
          to: boundOf(type, draft.to),
        };
      case 'contains':
        return {
          key: draft.key,
          op: 'contains',
          value: draft.text.slice(0, FIELD_FILTER_TEXT_MAX),
        };
    }
  })();
  const parsed = ticketFieldFilterSchema.safeParse(candidate);

  return parsed.success ? parsed.data : null;
};

/** The complete filters of a list of drafts, in order, one per field. */
export const filtersOfDrafts = (
  drafts: readonly FieldFilterDraft[],
  defs: readonly Pick<CustomFieldDef, 'key' | 'type'>[],
): TicketFieldFilter[] =>
  drafts.flatMap((draft) => {
    const def = defs.find((candidate) => candidate.key === draft.key);
    const filter = def === undefined ? null : filterOfDraft(draft, def.type);

    return filter === null ? [] : [filter];
  });
