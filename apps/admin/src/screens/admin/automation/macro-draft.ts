import type {
  Macro,
  MacroAction,
  MacroActionType,
  MacroCreateRequest,
  MacroKind,
  MacroScope,
  TicketPriority,
} from '@helpdock/schemas';

/**
 * The Macros tab's editor as plain values (M3-06): what the form holds, how it
 * becomes a request, and what is still missing before it can be saved. Pure,
 * so the rules are tested without drawing the form.
 *
 * An action is held as its type and one string, because each row of the
 * artboard's Actions fieldset is exactly two selects. The assignee select's
 * value carries its kind: `self`, `unassigned`, `user:<id>` or `team:<id>`.
 */

export interface DraftAction {
  readonly type: MacroActionType;
  /** '' until the second select has been chosen. */
  readonly value: string;
}

export interface MacroDraft {
  readonly kind: MacroKind;
  readonly name: string;
  readonly scope: MacroScope;
  /** '' is every department. */
  readonly departmentId: string;
  readonly en: string;
  readonly ar: string;
  readonly actions: readonly DraftAction[];
}

export const emptyDraft = (kind: MacroKind, scope: MacroScope): MacroDraft => ({
  kind,
  name: '',
  scope,
  departmentId: '',
  en: '',
  ar: '',
  actions: [],
});

const selectValueOf = (action: MacroAction): string => {
  switch (action.type) {
    case 'set_status':
      return action.statusId;
    case 'set_priority':
      return action.priority;
    case 'add_tag':
    case 'remove_tag':
      return action.tagId;
    case 'assign': {
      const { assignee } = action;
      return assignee.kind === 'user'
        ? `user:${assignee.userId}`
        : assignee.kind === 'team'
          ? `team:${assignee.teamId}`
          : assignee.kind;
    }
  }
};

export const draftOf = (macro: Macro): MacroDraft => ({
  kind: macro.kind,
  name: macro.name,
  scope: macro.scope,
  departmentId: macro.departmentId ?? '',
  en: macro.bodies.en,
  ar: macro.bodies.ar,
  actions: macro.actions.map((action) => ({ type: action.type, value: selectValueOf(action) })),
});

const PRIORITIES: readonly TicketPriority[] = ['low', 'medium', 'high', 'urgent'];

/** One row as the api's action, or null while its second select is empty. */
export const actionOf = ({ type, value }: DraftAction): MacroAction | null => {
  if (value === '') {
    return null;
  }

  switch (type) {
    case 'set_status':
      return { type, statusId: value };
    case 'set_priority':
      return PRIORITIES.includes(value as TicketPriority)
        ? { type, priority: value as TicketPriority }
        : null;
    case 'add_tag':
    case 'remove_tag':
      return { type, tagId: value };
    case 'assign': {
      if (value === 'self' || value === 'unassigned') {
        return { type, assignee: { kind: value } };
      }
      const [kind, id = ''] = value.split(':');
      if (kind === 'user') {
        return { type, assignee: { kind: 'user', userId: id } };
      }
      return kind === 'team' ? { type, assignee: { kind: 'team', teamId: id } } : null;
    }
  }
};

/** What stops the draft being saved, as a catalog key, or null when it can be. */
export type DraftProblem =
  | 'nameRequired'
  | 'englishRequired'
  | 'nothingToDo'
  | 'actionIncomplete'
  | 'arabicWithoutEnglish';

export const problemOf = (draft: MacroDraft): DraftProblem | null => {
  if (draft.name.trim() === '') {
    return 'nameRequired';
  }
  if (draft.kind === 'canned' && draft.en.trim() === '') {
    return 'englishRequired';
  }
  if (draft.actions.some((action) => actionOf(action) === null)) {
    return 'actionIncomplete';
  }
  if (draft.kind === 'macro' && draft.en.trim() === '' && draft.actions.length === 0) {
    return 'nothingToDo';
  }
  if (draft.en.trim() === '' && draft.ar.trim() !== '') {
    return 'arabicWithoutEnglish';
  }

  return null;
};

/** The create request, once {@link problemOf} has nothing to say. */
export const requestOf = (draft: MacroDraft): MacroCreateRequest => ({
  kind: draft.kind,
  name: draft.name.trim(),
  scope: draft.scope,
  departmentId: draft.scope === 'personal' || draft.departmentId === '' ? null : draft.departmentId,
  bodies: { en: draft.en, ar: draft.ar },
  actions:
    draft.kind === 'canned' ? [] : draft.actions.map(actionOf).filter((action) => action !== null),
});

/** A copy for the Duplicate button: the same item, not yet saved, named so. */
export const duplicateOf = (draft: MacroDraft, copyName: string): MacroDraft => ({
  ...draft,
  name: copyName,
});

/**
 * Text with `token` put where the caret was, and where the caret goes next.
 * The placeholder picker inserts "at the cursor" (artboard), and a caret the
 * browser has not reported yet counts as the end.
 */
export const insertAt = (
  text: string,
  token: string,
  selection: { readonly start: number; readonly end: number } | null,
): { text: string; caret: number } => {
  const start = selection?.start ?? text.length;
  const end = selection?.end ?? start;

  return { text: `${text.slice(0, start)}${token}${text.slice(end)}`, caret: start + token.length };
};
