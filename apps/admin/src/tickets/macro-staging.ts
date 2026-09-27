import type { Macro, MacroAction, Ticket } from '@helpdock/schemas';

/**
 * What a macro will do to one ticket, in the words the composer shows
 * (artboard `AdminComposerMacros`, "When you send the reply"): each staged
 * action as the field it moves, from what to what. Pure, so the wording rules
 * are tested without drawing the picker.
 *
 * Names are looked up by the caller's functions, because the screen already
 * holds the directory and this module should not know where it came from.
 */

export interface StagedMacro {
  readonly macro: Pick<Macro, 'id' | 'name'>;
  /** The actions still staged; each chip's remove button takes one out. */
  readonly actions: readonly MacroAction[];
}

export type StagedLine =
  | { readonly field: 'status'; readonly from: string; readonly to: string }
  | { readonly field: 'priority'; readonly from: string; readonly to: string }
  | { readonly field: 'tag'; readonly add: boolean; readonly name: string }
  | {
      readonly field: 'assignee';
      readonly to: string | null;
      /** The ticket is already theirs: the line says "stays", not "moves". */
      readonly unchanged: boolean;
    };

export interface StagingLookups {
  readonly viewerId: string;
  statusName(statusId: string): string;
  tagName(tagId: string): string;
  personName(userId: string): string;
  teamName(teamId: string): string;
  priorityName(priority: Ticket['priority']): string;
}

export const describeAction = (
  action: MacroAction,
  ticket: Pick<Ticket, 'status' | 'priority' | 'assigneeId'>,
  lookups: StagingLookups,
): StagedLine => {
  switch (action.type) {
    case 'set_status':
      return {
        field: 'status',
        from: lookups.statusName(ticket.status.id),
        to: lookups.statusName(action.statusId),
      };
    case 'set_priority':
      return {
        field: 'priority',
        from: lookups.priorityName(ticket.priority),
        to: lookups.priorityName(action.priority),
      };
    case 'add_tag':
    case 'remove_tag':
      return { field: 'tag', add: action.type === 'add_tag', name: lookups.tagName(action.tagId) };
    case 'assign': {
      const { assignee } = action;
      const userId =
        assignee.kind === 'self'
          ? lookups.viewerId
          : assignee.kind === 'user'
            ? assignee.userId
            : null;
      const to =
        userId !== null
          ? lookups.personName(userId)
          : assignee.kind === 'team'
            ? lookups.teamName(assignee.teamId)
            : null;

      return { field: 'assignee', to, unchanged: userId !== null && userId === ticket.assigneeId };
    }
  }
};

/** Whether the staged macro sets the status, which wins over "Then set status". */
export const setsStatus = (staged: StagedMacro | null): boolean =>
  staged?.actions.some((action) => action.type === 'set_status') ?? false;

/** Staged text for the composer: the rendered reply, after whatever was already typed. */
export const withInserted = (body: string, text: string): string =>
  body.trim() === '' ? text : `${body.trimEnd()}\n\n${text}`;
