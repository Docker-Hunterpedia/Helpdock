import { customFieldDefs, type DbTransaction, tickets } from '@helpdock/db';
import type { CustomFieldType, TicketFieldFilter } from '@helpdock/schemas';
import { BadRequestException } from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';

/**
 * Custom-field filters of the ticket list (M14-16): checked against the
 * brand's definitions, then compiled to SQL.
 *
 * The values live in `tickets.custom`, a jsonb object keyed by the definition's
 * key, and the database enforces nothing about its shape (`custom-fields.ts` in
 * `@helpdock/schemas` says why). So a filter is never trusted to say what type
 * its field is: {@link resolveFieldFilters} reads the type from the definition,
 * refuses an operator that does not suit it, and only a resolved filter reaches
 * {@link fieldFilterClause}. Every value from the request reaches SQL as a
 * bound parameter; the key goes in as one too, through `->`'s text operand.
 *
 * Nothing here isolates by brand or by department: `tickets` is read under the
 * reader's policies like every other list filter, so a filter only narrows what
 * the reader may already see.
 *
 * There is no index on `tickets.custom`. A GIN (`jsonb_path_ops`) was built and
 * measured on the 50k-ticket dataset of DOMAIN-RULES §14: the planner never
 * chose it, because `jsonb`'s `@>` is not LEAKPROOF and so cannot run ahead of
 * the `FORCE`d policies, and the list is paged by `tickets_brand_*` indexes
 * anyway. It would have cost every ticket write for no read.
 */

/** What the compiler needs of a definition. */
export interface FilterableField {
  readonly key: string;
  readonly type: CustomFieldType;
  readonly agentVisible: boolean;
}

/** A filter that has been checked against the definition it names. */
export interface ResolvedFieldFilter {
  readonly filter: TicketFieldFilter;
  readonly type: CustomFieldType;
}

/** The request names a field or an operator the brand cannot answer. */
export class FieldFilterFailure extends BadRequestException {
  constructor(key: string, reason: string) {
    super(`The filter on "${key}" cannot be applied: ${reason}`);
  }
}

/** Which operators each type answers (the table in `ticket-field-filter.ts`). */
const OPERATORS: Readonly<Record<CustomFieldType, readonly TicketFieldFilter['op'][]>> = {
  text: ['contains', 'not_set'],
  number: ['before', 'after', 'between', 'not_set'],
  date: ['before', 'after', 'between', 'not_set'],
  select: ['any_of', 'not_set'],
  multi_select: ['any_of', 'not_set'],
  checkbox: ['is', 'not_set'],
};

/** The bound a range names, as the type carries it: a number, or a `YYYY-MM-DD` day. */
const boundMatchesType = (type: CustomFieldType, bound: number | string): boolean =>
  type === 'number' ? typeof bound === 'number' : typeof bound === 'string';

const boundsOf = (filter: TicketFieldFilter): readonly (number | string)[] => {
  switch (filter.op) {
    case 'before':
    case 'after':
      return [filter.value];
    case 'between':
      return [filter.from, filter.to];
    default:
      return [];
  }
};

/**
 * Checks each filter against the brand's ticket fields.
 *
 * `seesHidden` is whether the reader may see a field an Agent may not
 * (`agentVisible` off): a filter on one would let a reader learn by narrowing
 * what the details panel keeps from them, so it is refused as if the field did
 * not exist.
 */
export const resolveFieldFilters = (
  filters: readonly TicketFieldFilter[] | undefined,
  fields: readonly FilterableField[],
  { seesHidden }: { readonly seesHidden: boolean },
): readonly ResolvedFieldFilter[] => {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const seen = new Set<string>();

  return (filters ?? []).map((filter) => {
    const field = byKey.get(filter.key);
    if (field === undefined || !(seesHidden || field.agentVisible)) {
      throw new FieldFilterFailure(filter.key, 'there is no such ticket field');
    }
    if (!OPERATORS[field.type].includes(filter.op)) {
      throw new FieldFilterFailure(filter.key, `a ${field.type} field has no "${filter.op}"`);
    }
    if (!boundsOf(filter).every((bound) => boundMatchesType(field.type, bound))) {
      throw new FieldFilterFailure(
        filter.key,
        `a ${field.type} field is compared with its own kind`,
      );
    }
    // Two filters on one field would be an AND the filter popover cannot draw
    // and no one means; the second is a mistake rather than a refinement.
    if (seen.has(filter.key)) {
      throw new FieldFilterFailure(filter.key, 'the field is filtered twice');
    }
    seen.add(filter.key);

    return { filter, type: field.type };
  });
};

/** `%` and `_` are wildcards to ILIKE; a word that contains one means the character. */
const escapeLike = (term: string): string =>
  term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

const value = (key: string): SQL => sql`${tickets.custom} -> ${key}::text`;
const valueText = (key: string): SQL => sql`${tickets.custom} ->> ${key}::text`;

/** `custom @> {"key": value}`: containment, which reads the stored shape (an array for a multi-select) as it is. */
const contains = (key: string, member: unknown): SQL =>
  sql`${tickets.custom} @> ${JSON.stringify({ [key]: member })}::jsonb`;

/**
 * A comparison that cannot raise on a value of another type. A `CASE` rather
 * than `AND`, because Postgres may evaluate the operands of `AND` in either
 * order and the cast would then see the wrong kind of value. A type is fixed
 * once rows carry values, but a stored object can still hold anything.
 */
const compare = ({ filter, type }: ResolvedFieldFilter, comparison: (read: SQL) => SQL): SQL => {
  if (type === 'number') {
    return sql`CASE WHEN jsonb_typeof(${value(filter.key)}) = 'number'
      THEN ${comparison(sql`(${valueText(filter.key)})::numeric`)} ELSE false END`;
  }

  // A day is `YYYY-MM-DD`, which sorts as text; "C" so locale rules never reorder digits.
  return sql`CASE WHEN jsonb_typeof(${value(filter.key)}) = 'string'
    THEN ${comparison(sql`(${valueText(filter.key)}) COLLATE "C"`)} ELSE false END`;
};

export const fieldFilterClause = (resolved: ResolvedFieldFilter): SQL => {
  const { filter, type } = resolved;

  switch (filter.op) {
    case 'any_of': {
      const matches = filter.values.map((option) =>
        // A multi-select holds an array, and `@>` on it asks whether the array has the member.
        contains(filter.key, type === 'multi_select' ? [option] : option),
      );

      return sql`(${sql.join(matches, sql` OR `)})`;
    }
    case 'not_set':
      return sql`NOT jsonb_exists(${tickets.custom}, ${filter.key})`;
    case 'is':
      // An unticked box and a box never touched are both "no" to a person.
      return filter.value ? contains(filter.key, true) : sql`NOT (${contains(filter.key, true)})`;
    case 'before':
      return compare(resolved, (read) => sql`${read} < ${filter.value}`);
    case 'after':
      return compare(resolved, (read) => sql`${read} > ${filter.value}`);
    case 'between':
      return compare(resolved, (read) => sql`${read} BETWEEN ${filter.from} AND ${filter.to}`);
    case 'contains':
      return sql`coalesce(${valueText(filter.key)} ILIKE ${`%${escapeLike(filter.value)}%`}, false)`;
  }
};

/** The brand's ticket fields, as the filters need them. Brand-scoped by row-level security. */
export const readFilterableFields = (tx: DbTransaction): Promise<FilterableField[]> =>
  tx
    .select({
      key: customFieldDefs.key,
      type: customFieldDefs.type,
      agentVisible: customFieldDefs.agentVisible,
    })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.target, 'ticket'));
