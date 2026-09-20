import { z } from 'zod';

/**
 * Custom fields (M1-06): the definitions a brand writes, and the Zod schema
 * that validates a `custom jsonb` value against them.
 *
 * The values live in one jsonb column per row rather than in a table of their
 * own (`packages/db/src/schema/custom-field-defs.ts` says why), which means the
 * database enforces nothing about their shape. This file is what does instead,
 * and it is the *only* thing that does: `apps/api` builds a schema from the
 * brand's definitions on every write, so a value that does not fit its
 * definition never reaches a column.
 *
 * The rules, once, so the api and the admin cannot disagree about them:
 *
 * | Type | Accepts | Stored as |
 * |---|---|---|
 * | `text` | a non-empty string | the trimmed string |
 * | `number` | a finite number, or a string holding one | a number |
 * | `date` | an ISO date or date-time | `YYYY-MM-DD` |
 * | `select` | one of the definition's options | that option |
 * | `multi_select` | a set of the definition's options | an array, no duplicates |
 * | `checkbox` | a boolean | a boolean |
 *
 * Three rules sit on top of the table. A key the brand has not defined is
 * **rejected**, never ignored, because a typo that is silently dropped is a
 * value somebody believes they saved. `null` **clears** a field, which is how
 * an editor unsets one. And `required` is enforced when a row is **created**
 * and not when one is patched: a `PATCH` that names two fields is not a
 * statement about the other eight.
 */

// --------------------------------------------------------------------------
// Vocabulary
// --------------------------------------------------------------------------

/** What a custom field hangs off (REQUIREMENTS §4.1). */
export const customFieldTargetSchema = z.enum(['ticket', 'contact', 'account']);
export type CustomFieldTarget = z.infer<typeof customFieldTargetSchema>;

export const customFieldTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'checkbox',
]);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

/** The two types whose values are drawn from {@link customFieldDefSchema}'s options. */
export const CHOICE_FIELD_TYPES: readonly CustomFieldType[] = ['select', 'multi_select'];

export const isChoiceField = (type: CustomFieldType): boolean => CHOICE_FIELD_TYPES.includes(type);

export const CUSTOM_FIELD_KEY_MAX = 60;
export const CUSTOM_FIELD_LABEL_MAX = 120;
export const CUSTOM_FIELD_OPTION_MAX = 80;
export const CUSTOM_FIELD_OPTIONS_MAX = 50;
export const CUSTOM_FIELD_TEXT_VALUE_MAX = 2000;
export const MAX_CUSTOM_FIELDS_PER_TARGET = 100;

/**
 * snake_case, starting with a letter. It is the key of a jsonb object, a column
 * name in an export and (from M3) an identifier in a rule condition, so it is
 * held to the narrowest spelling all three accept rather than to whatever jsonb
 * happens to allow.
 */
export const customFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(CUSTOM_FIELD_KEY_MAX)
  .regex(/^[a-z][a-z0-9_]*$/, 'A key is lower-case letters, digits and underscores');

const customFieldLabelSchema = z.string().trim().min(1).max(CUSTOM_FIELD_LABEL_MAX);
const customFieldOptionSchema = z.string().trim().min(1).max(CUSTOM_FIELD_OPTION_MAX);
const customFieldOptionsSchema = z.array(customFieldOptionSchema).max(CUSTOM_FIELD_OPTIONS_MAX);

// --------------------------------------------------------------------------
// The definition
// --------------------------------------------------------------------------

/** One definition, as the api returns it and the admin's editor fills it. */
export const customFieldDefSchema = z.object({
  id: z.uuid(),
  target: customFieldTargetSchema,
  key: z.string().min(1).max(CUSTOM_FIELD_KEY_MAX),
  label: z.string().min(1).max(CUSTOM_FIELD_LABEL_MAX),
  labelAr: z.string().min(1).max(CUSTOM_FIELD_LABEL_MAX).nullable(),
  type: customFieldTypeSchema,
  /** Empty for every type but `select` and `multi_select`. */
  options: z.array(z.string()),
  required: z.boolean(),
  /** Whether an Agent sees it. A display rule, never a security boundary. */
  agentVisible: z.boolean(),
  sortOrder: z.int().nonnegative(),
});
export type CustomFieldDef = z.infer<typeof customFieldDefSchema>;

export const customFieldDefListSchema = z.object({ fields: z.array(customFieldDefSchema) });
export type CustomFieldDefList = z.infer<typeof customFieldDefListSchema>;

/**
 * A choice type with no options would accept nothing and show an empty menu, so
 * it is refused at the boundary rather than saved and puzzled over later. The
 * mirror rule — options on a type that has no choices — is refused too, because
 * a list that is never read is a list that will be believed.
 */
const assertOptionsMatchType = (
  value: {
    readonly type?: CustomFieldType | undefined;
    readonly options?: readonly string[] | undefined;
  },
  ctx: z.RefinementCtx,
): void => {
  if (value.type === undefined) {
    return;
  }

  const options = value.options ?? [];
  if (isChoiceField(value.type) && options.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'A select field needs at least one option',
    });
  }
  if (!isChoiceField(value.type) && options.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Only select fields carry options',
    });
  }
  if (new Set(options).size !== options.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options have to be distinct' });
  }
};

export const customFieldCreateRequestSchema = z
  .object({
    target: customFieldTargetSchema,
    key: customFieldKeySchema,
    label: customFieldLabelSchema,
    labelAr: customFieldLabelSchema.nullish(),
    type: customFieldTypeSchema,
    options: customFieldOptionsSchema.default([]),
    required: z.boolean().default(false),
    agentVisible: z.boolean().default(true),
  })
  .superRefine(assertOptionsMatchType);
export type CustomFieldCreateRequest = z.infer<typeof customFieldCreateRequestSchema>;

/**
 * Everything a definition may change afterwards. `key` and `target` are absent
 * by construction rather than refused in the service: both are written into
 * every value that already exists, and a request that cannot name them cannot
 * ask for something the api then has to say no to.
 *
 * `force` is the answer to "that option is still in use": the api refuses the
 * removal and returns how many rows carry the option, and the editor asks
 * before sending the same request again with `force`.
 */
export const customFieldUpdateRequestSchema = z
  .object({
    label: customFieldLabelSchema.optional(),
    labelAr: customFieldLabelSchema.nullable().optional(),
    type: customFieldTypeSchema.optional(),
    options: customFieldOptionsSchema.optional(),
    required: z.boolean().optional(),
    agentVisible: z.boolean().optional(),
    /** Remove an option that rows still carry, clearing it from them. */
    force: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (Object.entries(value).every(([key, field]) => key === 'force' || field === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Send at least one field to change' });
    }
    // Only when the request moves the type: a request that changes the label
    // alone says nothing about options, and the stored ones stand.
    if (value.type !== undefined) {
      assertOptionsMatchType(value, ctx);
    }
  });
export type CustomFieldUpdateRequest = z.infer<typeof customFieldUpdateRequestSchema>;

/** The whole list of one target in its new order, as departments are reordered. */
export const customFieldReorderRequestSchema = z.object({
  target: customFieldTargetSchema,
  fieldIds: z.array(z.uuid()).min(1).max(MAX_CUSTOM_FIELDS_PER_TARGET),
});
export type CustomFieldReorderRequest = z.infer<typeof customFieldReorderRequestSchema>;

/**
 * How much is riding on a definition, read before a destructive change. The
 * editor shows `rows` in its confirmation, and `optionRows` is what refuses the
 * removal of an option somebody is still using.
 */
export const customFieldUsageSchema = z.object({
  fieldId: z.uuid(),
  /** Rows of the target that carry any value for this field. */
  rows: z.int().nonnegative(),
  /** Rows per option, for the choice types. Absent options carry no rows. */
  optionRows: z.record(z.string(), z.int().nonnegative()),
});
export type CustomFieldUsage = z.infer<typeof customFieldUsageSchema>;

export const customFieldParamSchema = z.object({
  brandId: z.uuid(),
  fieldId: z.uuid(),
});
export type CustomFieldParam = z.infer<typeof customFieldParamSchema>;

export const customFieldQuerySchema = z.object({
  /** Narrow the list to one target; the settings tab asks for all three. */
  target: customFieldTargetSchema.optional(),
});
export type CustomFieldQuery = z.infer<typeof customFieldQuerySchema>;

// --------------------------------------------------------------------------
// The values
// --------------------------------------------------------------------------

/** What {@link customValuesSchema} needs of a definition. */
export interface CustomFieldRule {
  readonly key: string;
  readonly type: CustomFieldType;
  readonly options: readonly string[];
  readonly required: boolean;
}

/**
 * A number, from a number or from the string a form field holds.
 *
 * `z.coerce.number()` is deliberately not used: it accepts `true`, `null` and
 * `[]` and turns them into 1, 0 and 0, which is how a checkbox ticked in the
 * wrong field becomes the number one and nobody finds out.
 */
const numberValueSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  z.number().finite(),
);

/**
 * A calendar day. A date-time is accepted because that is what a `Date` turned
 * into JSON looks like, and it is cut down to the day: a custom field of type
 * "date" is a day, and keeping the time would make two equal days compare
 * unequal.
 */
const dateValueSchema = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((value) => value.slice(0, 10));

const textValueSchema = z.string().trim().min(1).max(CUSTOM_FIELD_TEXT_VALUE_MAX);

/**
 * What a choice field with no options accepts: nothing. The definition
 * endpoints refuse to write one, so this catches a row that predates the rule
 * rather than a state the api can be talked into.
 */
const noChoices = z.never();

/** The schema for one field's value, from its definition. */
export const customValueSchema = (rule: CustomFieldRule): z.ZodType<unknown> => {
  switch (rule.type) {
    case 'text':
      return textValueSchema;
    case 'number':
      return numberValueSchema;
    case 'date':
      return dateValueSchema;
    case 'checkbox':
      return z.boolean();
    case 'select':
      return rule.options.length === 0
        ? noChoices
        : z.enum([...rule.options] as [string, ...string[]]);
    case 'multi_select':
      return rule.options.length === 0
        ? noChoices
        : z
            .array(z.enum([...rule.options] as [string, ...string[]]))
            .max(rule.options.length)
            .refine(
              (values) => new Set(values).size === values.length,
              'The same option twice is still one choice',
            );
  }
};

export interface CustomValuesOptions {
  /**
   * `true` for a `PATCH`: absent keys are left alone, and `required` is not
   * enforced. `false` for a create, where every required field has to arrive.
   */
  readonly partial?: boolean;
}

/**
 * The schema for a whole `custom` object, built from a brand's definitions.
 *
 * Strict, so a key nobody defined is an error rather than a value that is
 * accepted and then invisible. Every optional field also accepts `null`, which
 * means "clear it"; {@link mergeCustomValues} is what turns that into an
 * absence in the stored object.
 */
export const customValuesSchema = (
  rules: readonly CustomFieldRule[],
  { partial = false }: CustomValuesOptions = {},
): z.ZodType<Record<string, unknown>> => {
  const shape: Record<string, z.ZodType<unknown>> = {};

  for (const rule of rules) {
    const value = customValueSchema(rule);
    shape[rule.key] = rule.required && !partial ? value : value.nullish();
  }

  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
};

/**
 * The stored object after a patch: what was there, with what the patch names
 * written over it, and any key the patch set to `null` removed.
 *
 * Removing rather than storing a null keeps "unset" to one representation. Two
 * would mean every reader — the details panel, an export, a rule condition —
 * had to know both.
 *
 * It is built through a `Map` and `Object.fromEntries` rather than by assigning
 * `merged[key]`. Assignment goes through `[[Set]]`, so a key of `__proto__`
 * would reach the prototype setter instead of becoming an entry;
 * `Object.fromEntries` defines own properties and has no such door.
 * {@link customFieldKeySchema} already makes that key impossible on the way in,
 * but a function exported from a package is called by code this file cannot
 * see, and "safe because of who calls it" is not safe.
 */
export const mergeCustomValues = (
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = new Map(Object.entries(current));

  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      merged.delete(key);
    } else {
      merged.set(key, value);
    }
  }

  return Object.fromEntries(merged);
};

/**
 * The stored object with every key no definition names removed, and with the
 * keys an Agent may not see removed when `agentVisible` is the question.
 *
 * A row can hold a key whose definition was deleted — deleting a definition
 * does not rewrite every row that used it, because that is a migration over the
 * whole brand for a change somebody may undo in a minute — so reads filter
 * rather than trusting what is stored.
 *
 * Built with `Object.fromEntries` for the reason {@link mergeCustomValues}
 * gives: the keys come from a stored jsonb column, which is not a place to
 * assume anything about.
 */
export const visibleCustomValues = (
  values: Record<string, unknown>,
  defs: readonly CustomFieldDef[],
): Record<string, unknown> => {
  const known = new Set(defs.map((def) => def.key));

  return Object.fromEntries(Object.entries(values).filter(([key]) => known.has(key)));
};
