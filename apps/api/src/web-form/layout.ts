import type { StoredWebFormField } from '@helpdock/db';
import {
  type CustomFieldType,
  customFieldRef,
  customKeyOfRef,
  isBuiltinField,
  WEB_FORM_BUILTIN_FIELDS,
  WEB_FORM_LOCKED_FIELDS,
  type WebFormBuiltinField,
  type WebFormField,
  type WebFormFieldType,
  type WebFormFieldUpdate,
} from '@helpdock/schemas';

/**
 * How the hosted form's fields are arranged (M4-09): the stored layout, the
 * brand's ticket custom fields, and the rules that bind the two.
 *
 * Two sources describe one list. The layout in `web_form_settings.fields`
 * holds the order and the "required" of every field, and the "shown" of the
 * built-in ones; whether a custom field is shown is its own "Show on web form"
 * flag, `custom_field_defs.web_form`, because that is a fact about the field
 * the custom field editor may one day show too. Everything is reconciled here,
 * on every read, so a field defined after the form was last saved still
 * appears (at the end, not shown), and a deleted one simply drops out.
 */

/** What this file needs of a ticket custom field definition. */
export interface WebFormFieldDef {
  readonly key: string;
  readonly label: string;
  readonly labelAr: string | null;
  readonly type: CustomFieldType;
  readonly options: readonly string[];
  readonly webForm: boolean;
}

const BUILTIN_TYPES: Readonly<Record<WebFormBuiltinField, WebFormFieldType>> = {
  name: 'name',
  email: 'email',
  subject: 'subject',
  message: 'long_text',
};

/** A new brand's form: all four built-in fields, Name and Subject optional. */
type BuiltinEntry = StoredWebFormField & { readonly field: WebFormBuiltinField };

const DEFAULT_BUILTINS: readonly BuiltinEntry[] = WEB_FORM_BUILTIN_FIELDS.map((field) => ({
  field,
  shown: true,
  required: isLocked(field),
}));

function isLocked(field: string): boolean {
  return (WEB_FORM_LOCKED_FIELDS as readonly string[]).includes(field);
}

const builtinField = (entry: BuiltinEntry): WebFormField => {
  const locked = isLocked(entry.field);
  const shown = locked || entry.shown;

  return {
    field: entry.field,
    kind: 'builtin',
    label: '',
    labelAr: null,
    type: BUILTIN_TYPES[entry.field],
    shown,
    required: locked || (shown && entry.required),
    locked,
  };
};

const customField = (def: WebFormFieldDef, required: boolean): WebFormField => ({
  field: customFieldRef(def.key),
  kind: 'custom',
  label: def.label,
  labelAr: def.labelAr,
  type: def.type,
  shown: def.webForm,
  required: def.webForm && required,
  locked: false,
});

/**
 * The form as the Web form tab lists it and the public page draws it: every
 * built-in field once, then every custom field, in the stored order.
 */
export const resolveFields = (
  stored: readonly StoredWebFormField[],
  defs: readonly WebFormFieldDef[],
): WebFormField[] => {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  const fields: WebFormField[] = [];
  const seen = new Set<string>();

  for (const entry of stored) {
    if (seen.has(entry.field)) {
      continue;
    }
    if (isBuiltinField(entry.field)) {
      fields.push(builtinField({ ...entry, field: entry.field }));
      seen.add(entry.field);
      continue;
    }
    const def = byKey.get(customKeyOfRef(entry.field) ?? '');
    if (def !== undefined) {
      fields.push(customField(def, entry.required));
      seen.add(entry.field);
    }
  }

  // Built-in fields a stored layout lacks go where a new form has them, so
  // Email and Message can never go missing.
  for (const [index, entry] of DEFAULT_BUILTINS.entries()) {
    if (!seen.has(entry.field)) {
      fields.splice(Math.min(index, fields.length), 0, builtinField(entry));
      seen.add(entry.field);
    }
  }
  for (const def of defs) {
    const ref = customFieldRef(def.key);
    if (!seen.has(ref)) {
      fields.push(customField(def, false));
    }
  }

  return fields;
};

export class WebFormLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebFormLayoutError';
  }
}

/**
 * A saved field list as the two things it is stored as: the layout row and the
 * set of custom field keys to flag "Show on web form".
 *
 * @throws {WebFormLayoutError} when a built-in field is missing or repeated, or
 *   a custom field does not exist. Locked fields are coerced rather than
 *   refused: the checkboxes for them are disabled, so a request that says
 *   otherwise is a stale screen, not an intention.
 */
export const layoutFromUpdate = (
  update: readonly WebFormFieldUpdate[],
  defs: readonly WebFormFieldDef[],
): { readonly layout: StoredWebFormField[]; readonly shownKeys: string[] } => {
  const known = new Set(defs.map((def) => def.key));
  const seen = new Set<string>();
  const layout: StoredWebFormField[] = [];
  const shownKeys: string[] = [];

  for (const entry of update) {
    if (seen.has(entry.field)) {
      throw new WebFormLayoutError(`${entry.field} is listed twice`);
    }
    seen.add(entry.field);

    const key = customKeyOfRef(entry.field);
    if (key !== null && !known.has(key)) {
      throw new WebFormLayoutError(`No ticket custom field has the key ${key}`);
    }

    const locked = isLocked(entry.field);
    const shown = locked || entry.shown;
    layout.push({ field: entry.field, shown, required: locked || (shown && entry.required) });
    if (key !== null && shown) {
      shownKeys.push(key);
    }
  }

  for (const field of WEB_FORM_BUILTIN_FIELDS) {
    if (!seen.has(field)) {
      throw new WebFormLayoutError(`The ${field} field is missing`);
    }
  }

  return { layout, shownKeys };
};
