import { z } from 'zod';
import { localeSchema } from './brand.js';
import { AGENT_PLACEHOLDERS } from './placeholders.js';
import {
  messageCreateRequestSchema,
  snoozeActionSchema,
  ticketMessageSchema,
  ticketPrioritySchema,
} from './ticket.js';
import { TEMPLATE_PLACEHOLDERS } from './ticket-templates.js';

/**
 * Macros and canned responses (M3-06, REQUIREMENTS §4.1).
 *
 * **One record, two kinds.** A canned response is a reply with placeholders in
 * `en` and `ar`; a macro is the same editor plus actions — set status, set
 * priority, add or remove a tag, assign — and its reply is optional. The
 * artboard (`AdminAutomationMacros`) lists them together and edits them with one
 * form, and REQUIREMENTS names "reply with canned response" as one of a macro's
 * actions, so they are one table with a `kind` rather than two that would have
 * to be listed, searched and scoped in step.
 *
 * **Shared or personal.** A shared one belongs to a department, or to every
 * department when `departmentId` is null, and is edited by an Admin or by a Team
 * Leader of that department. A personal one belongs to its owner alone, and
 * row-level security keeps it that way (`OWNER_SCOPED_TABLES`).
 *
 * **Bodies are plain text.** They are escaped and wrapped into paragraphs on the
 * way into a message, exactly as a ticket template is, so nothing stored here is
 * ever rendered as markup.
 */

export const MACRO_NAME_MAX_LENGTH = 120;
export const MACRO_BODY_MAX = 20_000;
export const MAX_MACRO_ACTIONS = 10;
export const MAX_MACROS_PER_BRAND = 500;

/**
 * M1-06's placeholders plus the one a reply needs that a new ticket does not:
 * who is sending it. An allow-list for the reason `TEMPLATE_PLACEHOLDERS` gives.
 */
export const CANNED_PLACEHOLDERS = [
  ...TEMPLATE_PLACEHOLDERS,
  'agent.first_name',
  ...AGENT_PLACEHOLDERS,
] as const;
export type CannedPlaceholder = (typeof CANNED_PLACEHOLDERS)[number];

export const MACRO_SHORTCUT_MAX_LENGTH = 32;

/**
 * The word typed after `/` to insert an item (M14-14): letters of any script,
 * digits, `-` and `_`, never starting with a separator, with no spaces so the
 * composer knows where it ends. Lower-cased, so `/Refund` and `/refund` are one.
 */
export const macroShortcutSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(MACRO_SHORTCUT_MAX_LENGTH)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u, 'Use letters, digits, - and _ only');

// --------------------------------------------------------------------------
// The check at save time (M14-14)
// --------------------------------------------------------------------------

/** A problem with a reply's placeholders. `text` is what was written, `suggestion` the nearest real name. */
export type PlaceholderProblem =
  | { readonly kind: 'unknown'; readonly text: string; readonly suggestion: string | null }
  | { readonly kind: 'unclosed'; readonly text: string };

const WRITTEN_NAME = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i;

/** Edit distance, for "Did you mean": names are short, so the plain table is fine. */
const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length] ?? 0;
};

const nearestPlaceholder = (name: string): string | null => {
  let best: { name: string; score: number } | null = null;
  for (const candidate of CANNED_PLACEHOLDERS) {
    const score = distance(name.toLowerCase(), candidate);
    if (score <= 2 && (best === null || score < best.score)) {
      best = { name: candidate, score };
    }
  }

  return best?.name ?? null;
};

/**
 * Every `{{` in a reply that would not render: a name that is not on the
 * allow-list, or an opening with no closing `}}`. Rendering leaves such text as
 * written (so an author sees the typo), and saving refuses it so the typo never
 * reaches a customer. A `|fallback` is allowed after any real name. Each problem
 * is reported once, in the order it first appears.
 */
export const placeholderProblems = (text: string): PlaceholderProblem[] => {
  const problems: PlaceholderProblem[] = [];
  const seen = new Set<string>();
  const add = (problem: PlaceholderProblem): void => {
    const key = `${problem.kind}:${problem.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push(problem);
    }
  };

  let from = 0;
  for (let open = text.indexOf('{{', from); open !== -1; open = text.indexOf('{{', from)) {
    const close = text.indexOf('}}', open + 2);
    const next = text.indexOf('{{', open + 2);
    if (close === -1 || (next !== -1 && next < close)) {
      const end = next === -1 ? open + 24 : Math.min(open + 24, next);
      add({ kind: 'unclosed', text: text.slice(open, end) });
      from = open + 2;
      continue;
    }
    const inner = text.slice(open + 2, close);
    const name = (inner.split('|')[0] ?? '').trim();
    if (
      !(
        WRITTEN_NAME.test(name) &&
        (CANNED_PLACEHOLDERS as readonly string[]).includes(name.toLowerCase())
      )
    ) {
      add({ kind: 'unknown', text: `{{${inner}}}`, suggestion: nearestPlaceholder(name) });
    }
    from = close + 2;
  }

  return problems;
};

/** The sentence the api answers with: each problem named. Null when the replies are sound. */
export const placeholderProblemSentence = (bodies: {
  readonly en: string;
  readonly ar: string;
}): string | null => {
  const lines = (['en', 'ar'] as const).flatMap((locale) =>
    placeholderProblems(bodies[locale]).map((problem) =>
      problem.kind === 'unknown'
        ? `Unknown placeholder ${problem.text} in the ${locale} reply`
        : `Unclosed ${problem.text} in the ${locale} reply`,
    ),
  );

  return lines.length === 0 ? null : lines.join('; ');
};

/** The languages a reply is written in: the interface's two (REQUIREMENTS §4.13). */
export type MacroLocale = z.infer<typeof localeSchema>;

export const macroKindSchema = z.enum(['macro', 'canned']);
export type MacroKind = z.infer<typeof macroKindSchema>;

export const macroScopeSchema = z.enum(['shared', 'personal']);
export type MacroScope = z.infer<typeof macroScopeSchema>;

/** Who an `assign` action hands the ticket to. */
export const macroAssigneeSchema = z.discriminatedUnion('kind', [
  /** Whoever applies the macro. */
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('user'), userId: z.uuid() }),
  /** The team, and the department's rotation picks the person (M1-07). */
  z.object({ kind: z.literal('team'), teamId: z.uuid() }),
  z.object({ kind: z.literal('unassigned') }),
]);
export type MacroAssignee = z.infer<typeof macroAssigneeSchema>;

export const macroActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_status'), statusId: z.uuid() }),
  z.object({ type: z.literal('set_priority'), priority: ticketPrioritySchema }),
  z.object({ type: z.literal('add_tag'), tagId: z.uuid() }),
  z.object({ type: z.literal('remove_tag'), tagId: z.uuid() }),
  z.object({ type: z.literal('assign'), assignee: macroAssigneeSchema }),
  /**
   * #368: snoozes with one of the Snooze menu's presets, which the server
   * resolves against the ticket's department calendar when the macro is
   * applied, and runs through the same update as a person's snooze — the same
   * activity, outbox event and wake timer. A closed ticket is refused, as a
   * person's snooze is.
   */
  snoozeActionSchema,
]);
export type MacroAction = z.infer<typeof macroActionSchema>;
export type MacroActionType = MacroAction['type'];

/**
 * The reply in each language. English is the default and the fallback: an empty
 * Arabic variant is answered with the English one (artboard, "an empty Arabic
 * variant falls back to English").
 */
export const macroBodiesSchema = z.object({
  en: z.string().max(MACRO_BODY_MAX),
  ar: z.string().max(MACRO_BODY_MAX),
});
export type MacroBodies = z.infer<typeof macroBodiesSchema>;

export const macroSchema = z.object({
  id: z.uuid(),
  kind: macroKindSchema,
  name: z.string().min(1).max(MACRO_NAME_MAX_LENGTH),
  scope: macroScopeSchema,
  /** Shared only: null is every department. Always null for a personal one. */
  departmentId: z.uuid().nullable(),
  bodies: macroBodiesSchema,
  /** M14-14: the word after `/` that inserts it, unique within its scope. Null for none. */
  shortcut: z.string().nullable(),
  /** Empty for a canned response. */
  actions: z.array(macroActionSchema).max(MAX_MACRO_ACTIONS),
  lastUsedAt: z.iso.datetime().nullable(),
  /** M14-14: how many times it has been used, for the picker's order. */
  useCount: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  /** The staff member who last saved it. Null for a row written before M3-06 kept it. */
  updatedById: z.uuid().nullable(),
  /** Whether the reader may change it: always for their own, by role for a shared one. */
  canEdit: z.boolean(),
});
export type Macro = z.infer<typeof macroSchema>;

export const macroListSchema = z.object({ macros: z.array(macroSchema) });
export type MacroList = z.infer<typeof macroListSchema>;

export const macroListQuerySchema = z.object({
  kind: macroKindSchema.optional(),
  /** Name or text, case-insensitive. */
  q: z.string().trim().max(120).optional(),
  /**
   * The composer's narrowing: only what is shared with this department, shared
   * with every department, or the reader's own (artboard `AdminComposerMacros`).
   */
  departmentId: z.uuid().optional(),
});
export type MacroListQuery = z.infer<typeof macroListQuerySchema>;

const macroNameSchema = z.string().trim().min(1).max(MACRO_NAME_MAX_LENGTH);

const macroFieldsSchema = z.object({
  kind: macroKindSchema,
  name: macroNameSchema,
  scope: macroScopeSchema,
  departmentId: z.uuid().nullable().default(null),
  bodies: macroBodiesSchema,
  shortcut: macroShortcutSchema.nullable().default(null),
  actions: z.array(macroActionSchema).max(MAX_MACRO_ACTIONS).default([]),
});

/**
 * The rules one shape has to satisfy whether it arrives whole or as a patch
 * merged over the stored row, so the service checks the merged result with the
 * same function.
 */
export const macroShapeProblem = (macro: {
  readonly kind: MacroKind;
  readonly scope: MacroScope;
  readonly departmentId: string | null;
  readonly bodies: MacroBodies;
  readonly actions: readonly MacroAction[];
}): string | null => {
  if (macro.kind === 'canned' && macro.actions.length > 0) {
    return 'A canned response has no actions';
  }
  if (macro.kind === 'canned' && macro.bodies.en.trim() === '') {
    return 'A canned response needs its English text';
  }
  if (macro.kind === 'macro' && macro.actions.length === 0 && macro.bodies.en.trim() === '') {
    return 'A macro needs a reply, an action, or both';
  }
  if (macro.scope === 'personal' && macro.departmentId !== null) {
    return 'A personal item is not shared with a department';
  }
  if (macro.bodies.en.trim() === '' && macro.bodies.ar.trim() !== '') {
    return 'English is the default variant; write it before the Arabic one';
  }

  return null;
};

export const macroCreateRequestSchema = macroFieldsSchema.superRefine((value, context) => {
  const problem = macroShapeProblem(value) ?? placeholderProblemSentence(value.bodies);
  if (problem !== null) {
    context.addIssue({ code: 'custom', message: problem });
  }
});
export type MacroCreateRequest = z.infer<typeof macroCreateRequestSchema>;

export const macroUpdateRequestSchema = z
  .object({
    name: macroNameSchema.optional(),
    scope: macroScopeSchema.optional(),
    departmentId: z.uuid().nullable().optional(),
    bodies: macroBodiesSchema.optional(),
    shortcut: macroShortcutSchema.nullable().optional(),
    actions: z.array(macroActionSchema).max(MAX_MACRO_ACTIONS).optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Send at least one field to change',
  )
  .superRefine((value, context) => {
    const problem = value.bodies === undefined ? null : placeholderProblemSentence(value.bodies);
    if (problem !== null) {
      context.addIssue({ code: 'custom', path: ['bodies'], message: problem });
    }
  });
export type MacroUpdateRequest = z.infer<typeof macroUpdateRequestSchema>;

export const macroParamSchema = z.object({ brandId: z.uuid(), macroId: z.uuid() });
export type MacroParam = z.infer<typeof macroParamSchema>;

export const macroTicketParamSchema = z.object({
  brandId: z.uuid(),
  ticketId: z.uuid(),
  macroId: z.uuid(),
});
export type MacroTicketParam = z.infer<typeof macroTicketParamSchema>;

// --------------------------------------------------------------------------
// Rendering and applying
// --------------------------------------------------------------------------

export const macroRenderQuerySchema = z.object({
  /** Omitted, the contact's language, then the brand's default. */
  locale: localeSchema.optional(),
});
export type MacroRenderQuery = z.infer<typeof macroRenderQuerySchema>;

/**
 * A reply filled in for one ticket. `segments` keeps the runs that came from a
 * placeholder apart, so the picker can mark them; `text` is the same thing
 * joined, which is what goes into the composer.
 */
export const renderedMacroSchema = z.object({
  /** The variant used. */
  locale: localeSchema,
  /** The variant asked for was empty and English was used instead. */
  fellBack: z.boolean(),
  text: z.string(),
  segments: z.array(z.object({ text: z.string(), placeholder: z.string().nullable() })),
  unknownPlaceholders: z.array(z.string()),
});
export type RenderedMacro = z.infer<typeof renderedMacroSchema>;

/**
 * A macro applied to a ticket: the actions the agent kept (the composer stages
 * them as chips, and each can be removed before sending), and the reply they
 * run with. Without a reply the actions run at once.
 *
 * The actions are sent rather than implied, because the agent may have removed
 * some; each must still be one of the macro's own, so a request cannot run an
 * action "via macro X" that macro X does not have.
 */
export const macroRunRequestSchema = z.object({
  macroId: z.uuid(),
  actions: z.array(macroActionSchema).max(MAX_MACRO_ACTIONS).default([]),
  reply: messageCreateRequestSchema.optional(),
});
export type MacroRunRequest = z.infer<typeof macroRunRequestSchema>;

export const macroRunResponseSchema = z.object({
  /** The reply, when one was sent. */
  message: ticketMessageSchema.nullable(),
});
export type MacroRunResponse = z.infer<typeof macroRunResponseSchema>;
