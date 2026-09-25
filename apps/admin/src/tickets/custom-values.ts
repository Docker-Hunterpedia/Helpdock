import type { CustomFieldDef } from '@helpdock/schemas';

/**
 * What a custom field's editor holds, and what it sends (M1-06, M1-15).
 *
 * An input holds a string, a checkbox a boolean and a multi-select a list; the
 * api stores a number as a number and clears a field with `null`
 * (`@helpdock/schemas/custom-fields`). These two functions are the only place
 * the details panel converts between the two, so "empty means clear" is decided
 * once.
 *
 * Nothing is validated here. The api builds its schema from the brand's
 * definitions on every write, and a second copy of those rules in the browser
 * would be a second answer to what a field accepts; what the editor does with a
 * refusal is draw it under the field.
 */

export type CustomDraft = string | boolean | readonly string[];

/** The editor's starting state for a stored value, or for none. */
export const draftOf = (def: CustomFieldDef, value: unknown): CustomDraft => {
  switch (def.type) {
    case 'checkbox':
      return value === true;
    case 'multi_select':
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
    default:
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }
};

/**
 * The value a `PATCH` carries for an editor's state: `null` for an emptied
 * field, a number for a number field, the rest as they are.
 *
 * A number field that holds something `Number` cannot read is sent as the
 * string it is, so the api's refusal — rather than a silent clear — is what the
 * person sees.
 */
export const valueOfDraft = (def: CustomFieldDef, draft: CustomDraft): unknown => {
  if (typeof draft === 'boolean') {
    return draft;
  }
  if (typeof draft !== 'string') {
    return draft.length === 0 ? null : [...draft];
  }

  const text = def.type === 'text' ? draft.trim() : draft;
  if (text === '') {
    return null;
  }
  if (def.type === 'number') {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }

  return text;
};

/** Whether saving `draft` would change what is stored, so a blur that changed nothing sends nothing. */
export const draftChanges = (def: CustomFieldDef, stored: unknown, draft: CustomDraft): boolean =>
  JSON.stringify(valueOfDraft(def, draftOf(def, stored))) !==
  JSON.stringify(valueOfDraft(def, draft));

/** The definitions the details panel draws: the ticket's, minus those hidden from Agents for a reader who is one. */
export const ticketFieldsFor = (
  defs: readonly CustomFieldDef[],
  seesHidden: boolean,
): CustomFieldDef[] =>
  defs
    .filter((def) => def.target === 'ticket' && (seesHidden || def.agentVisible))
    .sort((a, b) => a.sortOrder - b.sortOrder);
