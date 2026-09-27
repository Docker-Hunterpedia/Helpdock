import type { Locale } from '@helpdock/i18n';
import {
  type ConditionTrace,
  RULE_FIELD_VALUE_KIND,
  type RuleAction,
  type RuleBuilderOptions,
  type RuleCondition,
  type RuleTrigger,
  type WorkflowRule,
} from '@helpdock/schemas';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';

/**
 * How a rule reads in a sentence: the list's one-line summary, the log's
 * details, the test run's traces. One hook, so the builder, the list and the
 * log can never describe the same condition two ways.
 *
 * Ids become names through the builder options; an id the options no longer
 * hold — a deleted tag — reads as "(deleted)", never as a uuid.
 */

export interface RuleText {
  trigger(trigger: RuleTrigger | 'schedule'): string;
  field(condition: Pick<RuleCondition, 'field' | 'key'>): string;
  value(field: RuleCondition['field'], value: string): string;
  condition(condition: RuleCondition): string;
  action(action: RuleAction): string;
  summary(rule: Pick<WorkflowRule, 'conditions' | 'actions'>): string;
  /** What a condition found on the ticket, for the test run and the log. */
  actual(trace: ConditionTrace): string;
}

type Named = { readonly id: string; readonly name: string; readonly nameAr?: string | null };

const nameIn = (list: readonly Named[], id: string, locale: Locale): string | undefined => {
  const found = list.find((entry) => entry.id === id);
  if (found === undefined) {
    return undefined;
  }
  return locale === 'ar' && found.nameAr ? found.nameAr : found.name;
};

export function useRuleText(options: RuleBuilderOptions | undefined): RuleText {
  const t = useT();
  const { locale } = usePreferences();
  const deleted = t('rules:text.deleted');

  const lookup = (list: readonly Named[] | undefined, id: string): string =>
    nameIn(list ?? [], id, locale) ?? deleted;

  const value = (field: RuleCondition['field'], raw: string): string => {
    switch (field) {
      case 'channel':
        return t(`rules:channels.${raw as 'email'}`, { defaultValue: raw });
      case 'priority':
        return t(`rules:priorities.${raw as 'low'}`, { defaultValue: raw });
      case 'status':
        return lookup(options?.statuses, raw);
      case 'department':
        return lookup(options?.departments, raw);
      case 'team':
        return lookup(options?.teams, raw);
      case 'tag':
        return lookup(options?.tags, raw);
      case 'assignee':
        return lookup(options?.members, raw);
      case 'account':
        return lookup(options?.accounts, raw);
      case 'business_hours':
        return t(`rules:businessHours.${raw === 'outside' ? 'outside' : 'inside'}`);
      default:
        return raw;
    }
  };

  const field = ({ field: name, key }: Pick<RuleCondition, 'field' | 'key'>): string => {
    if (name !== 'custom_field') {
      return t(`rules:fields.${name}`);
    }
    const custom = options?.customFields.find((candidate) => candidate.key === key);
    const label =
      custom === undefined
        ? (key ?? '')
        : locale === 'ar' && custom.labelAr
          ? custom.labelAr
          : custom.label;
    return t('rules:fields.custom', { label });
  };

  const condition = (entry: RuleCondition): string => {
    const subject = field(entry);
    const operator = t(`rules:operators.${entry.operator}`);
    if (entry.operator === 'is_set') {
      return t('rules:text.condition', { field: subject, operator, value: '' }).trim();
    }
    if (RULE_FIELD_VALUE_KIND[entry.field] === 'duration' && entry.duration !== undefined) {
      return t('rules:text.condition', {
        field: subject,
        operator,
        value: t(`rules:text.duration.${entry.duration.unit}`, { count: entry.duration.amount }),
      });
    }
    const values = entry.values.map((raw) => value(entry.field, raw));
    const quoted =
      RULE_FIELD_VALUE_KIND[entry.field] === 'text'
        ? values.map((text) => t('rules:text.quoted', { text }))
        : values;
    return t('rules:text.condition', {
      field: subject,
      operator,
      value: quoted.join(t('rules:text.listSeparator')),
    });
  };

  const cannedName = (id: string): string =>
    options?.cannedResponses.find((entry) => entry.id === id)?.name ?? deleted;

  const action = (entry: RuleAction): string => {
    switch (entry.type) {
      case 'set_status':
        return t('rules:text.action.set_status', {
          status: lookup(options?.statuses, entry.statusId),
        });
      case 'set_priority':
        return t('rules:text.action.set_priority', {
          priority: t(`rules:priorities.${entry.priority}`),
        });
      case 'set_field':
        return t('rules:text.action.set_field', {
          field: field({ field: 'custom_field', key: entry.key }),
          value: entry.value ?? '',
        });
      case 'assign_team':
        return t('rules:text.action.assign_team', { team: lookup(options?.teams, entry.teamId) });
      case 'assign_agent':
        return t('rules:text.action.assign_agent', {
          agent: lookup(options?.members, entry.userId),
        });
      case 'assign_round_robin':
        return t('rules:text.action.assign_round_robin');
      case 'add_tag':
        return t('rules:text.action.add_tag', { tag: lookup(options?.tags, entry.tagId) });
      case 'remove_tag':
        return t('rules:text.action.remove_tag', { tag: lookup(options?.tags, entry.tagId) });
      case 'send_canned':
        return t('rules:text.action.send_canned', { name: cannedName(entry.cannedResponseId) });
      case 'add_note':
        return t('rules:text.action.add_note');
      case 'notify':
        return t('rules:text.action.notify', {
          who:
            entry.recipient.kind === 'team'
              ? t('rules:recipients.teamNamed', {
                  team: lookup(options?.teams, entry.recipient.teamId),
                })
              : entry.recipient.kind === 'user'
                ? lookup(options?.members, entry.recipient.userId)
                : t(`rules:recipients.${entry.recipient.kind}`),
        });
      case 'escalate':
        return t('rules:text.action.escalate');
      case 'close':
        return t('rules:text.action.close');
    }
  };

  const summary = (rule: Pick<WorkflowRule, 'conditions' | 'actions'>): string => {
    const conditions = rule.conditions.groups.flatMap((group) => group.conditions);
    const actions = rule.actions.map(action).join(t('rules:text.listSeparator'));
    const [first] = conditions;
    if (first === undefined) {
      return actions;
    }
    return conditions.length === 1
      ? t('rules:text.summary', { condition: condition(first), actions })
      : t('rules:text.summaryMore', {
          condition: condition(first),
          count: conditions.length - 1,
          actions,
        });
  };

  const actual = (trace: ConditionTrace): string => {
    const found = trace.actual ?? [];
    if (found.length === 0) {
      return t('rules:text.noValue');
    }
    if (trace.condition.field === 'time_in_status') {
      return t('rules:text.minutesInStatus', { count: Number(found[0]) });
    }
    return found
      .map((raw) => value(trace.condition.field, raw))
      .join(t('rules:text.listSeparator'));
  };

  return {
    trigger: (trigger) => t(`rules:triggers.${trigger}`),
    field,
    value,
    condition,
    action,
    summary,
    actual,
  };
}
