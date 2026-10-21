import { z } from 'zod';
import { customFieldKeySchema } from './custom-fields.js';

/**
 * A filter on one ticket custom field (M14-16), in the ticket list's query and
 * in a saved view's filters.
 *
 * The operator says what is asked and the *field's type* says which operators
 * make sense for it: that pairing needs the brand's definitions, so the api
 * checks it (`apps/api/src/tickets/field-filters.ts`) and this schema checks
 * only the shape. A key that no definition names is refused there too.
 *
 * | Operator | Field types | Reads |
 * |---|---|---|
 * | `any_of` | select, multi-select | the value is one of `values` (any of them, for a multi-select) |
 * | `not_set` | every type | the ticket carries no value |
 * | `is` | checkbox | ticked (`true`) or not ticked (`false`) |
 * | `before`, `after` | number, date | strictly less or greater than `value` |
 * | `between` | number, date | `from` and `to` included |
 * | `contains` | text | the words as a substring, case-insensitive |
 */

export const FIELD_FILTERS_MAX = 10;
export const FIELD_FILTER_VALUES_MAX = 50;
export const FIELD_FILTER_VALUE_MAX = 80;
export const FIELD_FILTER_TEXT_MAX = 200;

/** A number, or a `YYYY-MM-DD` day; which one is the field's type to say. */
const boundSchema = z.union([z.number().finite(), z.iso.date()]);

const key = customFieldKeySchema;

export const ticketFieldFilterSchema = z
  .discriminatedUnion('op', [
    z.strictObject({
      key,
      op: z.literal('any_of'),
      values: z
        .array(z.string().trim().min(1).max(FIELD_FILTER_VALUE_MAX))
        .min(1)
        .max(FIELD_FILTER_VALUES_MAX),
    }),
    z.strictObject({ key, op: z.literal('not_set') }),
    z.strictObject({ key, op: z.literal('is'), value: z.boolean() }),
    z.strictObject({ key, op: z.literal('before'), value: boundSchema }),
    z.strictObject({ key, op: z.literal('after'), value: boundSchema }),
    z.strictObject({ key, op: z.literal('between'), from: boundSchema, to: boundSchema }),
    z.strictObject({
      key,
      op: z.literal('contains'),
      value: z.string().trim().min(1).max(FIELD_FILTER_TEXT_MAX),
    }),
  ])
  .refine((filter) => filter.op !== 'between' || sameKind(filter.from, filter.to), {
    message: 'A range has two numbers or two dates',
  })
  .refine((filter) => filter.op !== 'between' || filter.from <= filter.to, {
    message: 'A range starts before it ends',
  });
export type TicketFieldFilter = z.infer<typeof ticketFieldFilterSchema>;

function sameKind(left: number | string, right: number | string): boolean {
  return typeof left === typeof right;
}

/**
 * The filters as a query string carries them: one `fieldFilter` parameter per
 * filter, each a JSON object. A single value parses as a one-element list for
 * the reason the other repeatable filters do, and a member that is not JSON is
 * left as it is so the object schema is what names the problem.
 */
export const ticketFieldFiltersParamSchema = z.preprocess((value) => {
  if (value === undefined) {
    return undefined;
  }

  return (Array.isArray(value) ? value : [value]).map((member) => {
    if (typeof member !== 'string') {
      return member;
    }
    try {
      return JSON.parse(member) as unknown;
    } catch {
      return member;
    }
  });
}, z.array(ticketFieldFilterSchema).max(FIELD_FILTERS_MAX));
