import type { TicketingRefusal } from '@helpdock/schemas';

/**
 * Which sentence each ticketing refusal becomes.
 *
 * One map for the whole Ticketing screen rather than one per tab: the api
 * answers with a code from a single vocabulary, and a tab that knew only its
 * own half would show "that did not work" for a refusal it had never heard of.
 *
 * `satisfies` rather than a type annotation, so the keys are still checked
 * against {@link TicketingRefusal} — adding a refusal to the schema fails the
 * build here until it has copy — while the *values* keep their literal types.
 * `useT()` checks its argument against the catalogs, and a widened `string`
 * would defeat that check at exactly the place it matters.
 */
export const REFUSAL_COPY = {
  'out-of-scope': 'ticketing:toast.outOfScope',
  'last-department': 'ticketing:toast.lastDepartment',
  'department-in-use': 'ticketing:toast.departmentInUse',
  'name-taken': 'ticketing:toast.nameTaken',
  'not-eligible': 'ticketing:toast.notEligible',
  'field-in-use': 'ticketing:toast.fieldInUse',
  'option-in-use': 'ticketing:toast.optionInUse',
  'status-is-system': 'ticketing:toast.statusIsSystem',
  'status-is-default': 'ticketing:toast.statusIsDefault',
  'status-state-fixed': 'ticketing:toast.statusStateFixed',
  'default-must-be-open': 'ticketing:toast.defaultMustBeOpen',
  'sender-invalid': 'ticketing:toast.senderInvalid',
  'sender-is-own': 'ticketing:toast.senderIsOwn',
  'sender-already-blocked': 'ticketing:toast.senderAlreadyBlocked',
} as const satisfies Record<TicketingRefusal, string>;

/** The catalog key for one refusal, keeping the literal type `useT()` needs. */
export const refusalCopy = (reason: TicketingRefusal): (typeof REFUSAL_COPY)[TicketingRefusal] =>
  REFUSAL_COPY[reason];
