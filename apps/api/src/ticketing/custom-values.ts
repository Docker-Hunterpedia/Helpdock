import { customFieldDefs, type DbTransaction } from '@helpdock/db';
import type { CustomFieldRule, CustomFieldTarget } from '@helpdock/schemas';
import { customValuesSchema, mergeCustomValues } from '@helpdock/schemas';
import { BadRequestException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';

/**
 * The one way a `custom jsonb` value is written (M1-06).
 *
 * Custom field values are not shaped by the database — they live in one jsonb
 * column, which is what makes reading a ticket one row instead of eleven — so
 * the shape is enforced here, on every write, against the brand's own
 * definitions. `@helpdock/schemas/custom-fields` owns the rules; this file is
 * what reads the definitions inside the request's transaction and turns a
 * failure into a 400 rather than a 500.
 *
 * The read is not filtered by brand: the request's transaction carries
 * `app.brand_ids` and the policy on `custom_field_defs` applies it, as it does
 * to every other query in this app.
 *
 * Three callers, one function: `POST /tickets`, `PATCH /tickets/:id` and the
 * contact and account patches. A second spelling of "validate the custom
 * object" would be a second answer to what a brand's fields mean.
 */

export interface ParseCustomOptions {
  /**
   * `true` for a patch: absent keys are left alone and `required` is not
   * enforced. `false` for a create, where every required field has to arrive.
   */
  readonly partial: boolean;
}

/** The brand's definitions for one target, in the order the editor shows them. */
export const readFieldRules = async (
  tx: DbTransaction,
  target: CustomFieldTarget,
): Promise<CustomFieldRule[]> => {
  const rows = await tx
    .select({
      key: customFieldDefs.key,
      type: customFieldDefs.type,
      options: customFieldDefs.options,
      required: customFieldDefs.required,
    })
    .from(customFieldDefs)
    .where(eq(customFieldDefs.target, target))
    .orderBy(asc(customFieldDefs.sortOrder), asc(customFieldDefs.key));

  return rows;
};

/**
 * A readable sentence from a Zod failure, naming the field that was wrong.
 *
 * The messages are English and are for the log and for `curl`; nothing a person
 * reads in the admin is built from them. What the *screen* needs is which field
 * failed, and that is what the path carries.
 */
const describe = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const field = issue.path.join('.');
      return field === '' ? issue.message : `${field}: ${issue.message}`;
    })
    .join('; ');

/**
 * `input` validated against the brand's definitions for `target`.
 *
 * Returns the parsed object — coerced values, `null` kept as "clear this" —
 * which {@link mergeCustomValues} then applies to what is stored. An input of
 * `undefined` means the request said nothing about custom fields, and answers
 * `undefined` in turn, so a caller can tell "no change" from "change to
 * nothing".
 */
export const parseCustomValues = async (
  tx: DbTransaction,
  target: CustomFieldTarget,
  input: Record<string, unknown> | undefined,
  { partial }: ParseCustomOptions,
): Promise<Record<string, unknown> | undefined> => {
  const rules = await readFieldRules(tx, target);

  // A create has to be checked even when the request said nothing, because a
  // required field that is merely absent is still missing.
  if (input === undefined && (partial || rules.every((rule) => !rule.required))) {
    return undefined;
  }

  const result = customValuesSchema(rules, { partial }).safeParse(input ?? {});
  if (!result.success) {
    throw new BadRequestException(describe(result.error));
  }

  return result.data;
};

export { mergeCustomValues };
