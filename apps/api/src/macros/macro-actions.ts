import type { MacroAction, TicketPriority } from '@helpdock/schemas';

/**
 * What a macro's actions come to, worked out before anything is written
 * (M3-06). They "run in this order" (artboard `AdminAutomationMacros`), so a
 * later action on the same field wins, and a tag added then removed is not on
 * the ticket afterwards.
 *
 * Pure, so the order rules are tested on values; the service turns the plan
 * into one ticket update and one tag replacement.
 */

export interface MacroPlan {
  /** The ticket fields to write. Absent keys are left alone. */
  readonly fields: {
    statusId?: string;
    priority?: TicketPriority;
    assigneeId?: string | null;
    teamId?: string | null;
  };
  /** Tags to put on and take off, in the order the actions named them. */
  readonly tagOps: readonly { readonly tagId: string; readonly add: boolean }[];
  /** A team was assigned: the department's rotation picks the person (M1-07). */
  readonly routeToTeam: boolean;
}

export const planMacro = (actions: readonly MacroAction[], actorId: string): MacroPlan => {
  const fields: MacroPlan['fields'] = {};
  const tagOps: { tagId: string; add: boolean }[] = [];
  let routeToTeam = false;

  for (const action of actions) {
    switch (action.type) {
      case 'set_status':
        fields.statusId = action.statusId;
        break;
      case 'set_priority':
        fields.priority = action.priority;
        break;
      case 'add_tag':
      case 'remove_tag':
        tagOps.push({ tagId: action.tagId, add: action.type === 'add_tag' });
        break;
      case 'assign': {
        const { assignee } = action;
        routeToTeam = assignee.kind === 'team';
        if (assignee.kind === 'team') {
          fields.teamId = assignee.teamId;
          fields.assigneeId = null;
        } else {
          fields.assigneeId =
            assignee.kind === 'self' ? actorId : assignee.kind === 'user' ? assignee.userId : null;
        }
        break;
      }
    }
  }

  return { fields, tagOps, routeToTeam };
};

/** The ticket's tags after the plan's operations, in the order the ticket had them. */
export const tagsAfter = (
  current: readonly string[],
  ops: MacroPlan['tagOps'],
): readonly string[] => {
  const result = [...current];

  for (const { tagId, add } of ops) {
    const index = result.indexOf(tagId);
    if (add && index === -1) {
      result.push(tagId);
    } else if (!add && index !== -1) {
      result.splice(index, 1);
    }
  }

  return result;
};

/**
 * A stable spelling of one action, for comparing a staged action with the
 * macro's own. Keys sorted, so `{a,b}` and `{b,a}` are the same action.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner,
  );

/**
 * Whether every staged action is one of the macro's own. The composer lets an
 * agent remove staged actions, never invent them: an action that is not the
 * macro's would be recorded "via macro X" without X having it.
 */
export const actionsBelongTo = (
  staged: readonly MacroAction[],
  macroActions: readonly MacroAction[],
): boolean => {
  const own = new Set(macroActions.map(canonical));

  return staged.every((action) => own.has(canonical(action)));
};

/** Every id an action names, by kind, so the service can check they are the brand's. */
export const referencesOf = (
  actions: readonly MacroAction[],
): { statusIds: string[]; tagIds: string[]; userIds: string[]; teamIds: string[] } => {
  const refs = {
    statusIds: [] as string[],
    tagIds: [] as string[],
    userIds: [] as string[],
    teamIds: [] as string[],
  };

  for (const action of actions) {
    if (action.type === 'set_status') {
      refs.statusIds.push(action.statusId);
    } else if (action.type === 'add_tag' || action.type === 'remove_tag') {
      refs.tagIds.push(action.tagId);
    } else if (action.type === 'assign' && action.assignee.kind === 'user') {
      refs.userIds.push(action.assignee.userId);
    } else if (action.type === 'assign' && action.assignee.kind === 'team') {
      refs.teamIds.push(action.assignee.teamId);
    }
  }

  return refs;
};
