import {
  RULE_FIELD_VALUE_KIND,
  RULE_OPERATORS_BY_FIELD,
  type RuleAction,
  type RuleActionType,
  type RuleCondition,
  type RuleConditionField,
  type RuleCreateRequest,
  type RuleInterval,
  type RuleKind,
  type RuleMatch,
  type RuleOperator,
  type RuleTrigger,
  ruleDraftSchema,
  type WorkflowRule,
} from '@helpdock/schemas';

/**
 * The builder's working copy of a rule (M3-05): what the form edits, and the
 * two conversions it needs — from a saved rule, and to the request the api
 * takes. Pure, so every edit the form makes is a function a unit test can
 * call.
 *
 * Every group, condition and action carries a `key` of its own, because the
 * form reorders and removes rows and React needs something that survives both.
 */

let nextKey = 0;
const key = (): string => {
  nextKey += 1;
  return `k${nextKey}`;
};

export interface ConditionDraft {
  readonly key: string;
  readonly field: RuleConditionField;
  readonly operator: RuleOperator;
  readonly values: readonly string[];
  /** `custom_field` only. */
  readonly customKey: string;
  /** `time_in_status` only; text while it is being typed. */
  readonly amount: string;
  readonly unit: 'hours' | 'days';
}

export interface GroupDraft {
  readonly key: string;
  readonly match: RuleMatch;
  readonly conditions: readonly ConditionDraft[];
}

/** One action row. The builder edits the union's fields loosely and checks the whole on save. */
export interface ActionDraft {
  readonly key: string;
  readonly action: RuleAction;
}

export interface RuleDraftState {
  readonly name: string;
  readonly description: string;
  readonly kind: RuleKind;
  readonly trigger: RuleTrigger;
  readonly intervalMinutes: RuleInterval;
  readonly match: RuleMatch;
  readonly groups: readonly GroupDraft[];
  readonly actions: readonly ActionDraft[];
  readonly enabled: boolean;
}

/** A new condition on a field: its first operator, and no value yet. */
export const newCondition = (
  field: RuleConditionField = 'subject',
  customKey = '',
): ConditionDraft => ({
  key: key(),
  field,
  operator: RULE_OPERATORS_BY_FIELD[field][0] ?? 'is',
  values: [],
  customKey: field === 'custom_field' ? customKey : '',
  amount: RULE_FIELD_VALUE_KIND[field] === 'duration' ? '3' : '',
  unit: 'days',
});

export const newGroup = (): GroupDraft => ({
  key: key(),
  match: 'all',
  conditions: [newCondition()],
});

/** A placeholder action of a type. Ids are empty until the person picks one. */
export const newAction = (type: RuleActionType): RuleAction => {
  switch (type) {
    case 'set_status':
      return { type, statusId: '' };
    case 'set_priority':
      return { type, priority: 'high' };
    case 'set_field':
      return { type, key: '', value: '' };
    case 'assign_team':
      return { type, teamId: '' };
    case 'assign_agent':
      return { type, userId: '' };
    case 'add_tag':
    case 'remove_tag':
      return { type, tagId: '' };
    case 'send_canned':
      return { type, cannedResponseId: '', countsAsResponse: false };
    case 'add_note':
      return { type, body: '' };
    case 'notify':
      return { type, recipient: { kind: 'department_leads' }, message: null };
    case 'ai_triage':
      return { type, mode: 'suggest', fields: ['tags', 'priority', 'department'] };
    default:
      return { type };
  }
};

export const actionDraft = (action: RuleAction): ActionDraft => ({ key: key(), action });

/** The blank rule the "New rule" button opens, for either list. */
export const emptyDraft = (kind: RuleKind): RuleDraftState => ({
  name: '',
  description: '',
  kind,
  trigger: 'ticket_created',
  intervalMinutes: 15,
  match: 'all',
  groups: [newGroup()],
  actions: [actionDraft(newAction('assign_team'))],
  enabled: true,
});

const conditionDraft = (condition: RuleCondition): ConditionDraft => ({
  key: key(),
  field: condition.field,
  operator: condition.operator,
  values: condition.values,
  customKey: condition.key ?? '',
  amount: condition.duration === undefined ? '' : String(condition.duration.amount),
  unit: condition.duration?.unit ?? 'days',
});

export const draftOf = (rule: WorkflowRule): RuleDraftState => ({
  name: rule.name,
  description: rule.description ?? '',
  kind: rule.kind,
  trigger: rule.trigger ?? 'ticket_created',
  intervalMinutes: rule.intervalMinutes ?? 15,
  match: rule.conditions.match,
  groups: rule.conditions.groups.map((group) => ({
    key: key(),
    match: group.match,
    conditions: group.conditions.map(conditionDraft),
  })),
  actions: rule.actions.map(actionDraft),
  enabled: rule.enabled,
});

const conditionOf = (draft: ConditionDraft): Record<string, unknown> => {
  const kind = RULE_FIELD_VALUE_KIND[draft.field];
  return {
    field: draft.field,
    operator: draft.operator,
    values:
      draft.operator === 'is_set' || kind === 'duration'
        ? []
        : draft.values.map((value) => value.trim()).filter((value) => value !== ''),
    ...(draft.field === 'custom_field' ? { key: draft.customKey } : {}),
    ...(kind === 'duration'
      ? { duration: { amount: Number(draft.amount), unit: draft.unit } }
      : {}),
  };
};

/** The request the api takes, or null while something in the form is incomplete. */
export const requestOf = (draft: RuleDraftState): RuleCreateRequest | null => {
  const candidate = {
    name: draft.name.trim(),
    description: draft.description.trim() === '' ? null : draft.description.trim(),
    kind: draft.kind,
    ...(draft.kind === 'event'
      ? { trigger: draft.trigger }
      : { intervalMinutes: draft.intervalMinutes }),
    conditions: {
      match: draft.match,
      groups: draft.groups.map((group) => ({
        match: group.match,
        conditions: group.conditions.map(conditionOf),
      })),
    },
    actions: draft.actions.map((row) => row.action),
    enabled: draft.enabled,
  };

  const parsed = ruleDraftSchema.safeParse(candidate);
  return parsed.success ? (candidate as RuleCreateRequest) : null;
};

/** A condition with its field changed: a field's operators and values are its own. */
export const withField = (
  condition: ConditionDraft,
  field: RuleConditionField,
  customKey = '',
): ConditionDraft => ({ ...newCondition(field, customKey), key: condition.key });

export const withOperator = (
  condition: ConditionDraft,
  operator: RuleOperator,
): ConditionDraft => ({
  ...condition,
  operator,
  // "is any of" takes several values and the others one; keep the first.
  values: operator === 'any_of' ? condition.values : condition.values.slice(0, 1),
});

/** `items` with the one at `index` moved by `offset`, clamped to the ends. */
export const moveItem = <T>(items: readonly T[], index: number, offset: number): readonly T[] => {
  const target = Math.min(Math.max(index + offset, 0), items.length - 1);
  if (target === index || index < 0 || index >= items.length) {
    return items;
  }
  const moved = [...items];
  const [item] = moved.splice(index, 1);
  moved.splice(target, 0, item as T);
  return moved;
};
