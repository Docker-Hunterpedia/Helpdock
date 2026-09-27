import {
  RULE_FIELD_VALUE_KIND,
  RULE_OPERATORS_BY_FIELD,
  type RuleBuilderOptions,
  type RuleConditionField,
  ruleConditionFieldSchema,
  ruleOperatorSchema,
  ticketChannelSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { Box, IconButton, TextField, Typography } from '@mui/material';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Choice } from './choice.tsx';
import { type ConditionDraft, withField, withOperator } from './rule-draft.js';
import type { RuleText } from './rule-text.js';

/**
 * One condition of a group: field, operator, value, remove (`AdminRuleBuilder`,
 * the "If" section). The operators and the value editor follow the field —
 * text for a subject, a list for a channel, an amount and a unit for time in
 * status — and are exactly what `RULE_OPERATORS_BY_FIELD` allows, so the form
 * cannot build a condition the api would refuse.
 */

const CUSTOM_PREFIX = 'custom_field:';

/** The field select's value: a field, or a custom field by its key. */
const fieldValue = (condition: ConditionDraft): string =>
  condition.field === 'custom_field' ? `${CUSTOM_PREFIX}${condition.customKey}` : condition.field;

export interface ValueOption {
  readonly value: string;
  readonly label: string;
}

/** What a field's value may be picked from, when it is picked rather than typed. */
export function useValueOptions(
  options: RuleBuilderOptions | undefined,
): (field: RuleConditionField) => ValueOption[] {
  const t = useT();
  const { locale } = usePreferences();
  const named = (list: readonly { id: string; name: string; nameAr?: string | null }[]) =>
    list.map((entry) => ({
      value: entry.id,
      label: locale === 'ar' && entry.nameAr ? entry.nameAr : entry.name,
    }));

  return (field) => {
    switch (field) {
      case 'channel':
        return ticketChannelSchema.options.map((value) => ({
          value,
          label: t(`rules:channels.${value}`),
        }));
      case 'priority':
        return ticketPrioritySchema.options.map((value) => ({
          value,
          label: t(`rules:priorities.${value}`),
        }));
      case 'status':
        return named(options?.statuses ?? []);
      case 'department':
        return named(options?.departments ?? []);
      case 'team':
        return named(options?.teams ?? []);
      case 'tag':
        return named(options?.tags ?? []);
      case 'assignee':
        return named(options?.members ?? []);
      case 'account':
        return named(options?.accounts ?? []);
      case 'business_hours':
        return (['inside', 'outside'] as const).map((value) => ({
          value,
          label: t(`rules:businessHours.${value}`),
        }));
      default:
        return [];
    }
  };
}

export function ConditionRow({
  condition,
  options,
  text,
  onChange,
  onRemove,
}: {
  readonly condition: ConditionDraft;
  readonly options: RuleBuilderOptions | undefined;
  readonly text: RuleText;
  readonly onChange: (next: ConditionDraft) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const valueOptions = useValueOptions(options);
  const kind = RULE_FIELD_VALUE_KIND[condition.field];
  const choices = valueOptions(condition.field);
  const described = text.field({ field: condition.field, key: condition.customKey });

  const valueEditor = (): ReactNode => {
    if (condition.operator === 'is_set') {
      return (
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('rules:builder.noValue')}
        </Typography>
      );
    }
    if (kind === 'duration') {
      return (
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            size="small"
            type="number"
            value={condition.amount}
            onChange={(event) => {
              onChange({ ...condition, amount: event.target.value });
            }}
            slotProps={{ htmlInput: { min: 1, 'aria-label': t('rules:builder.duration') } }}
            sx={{ width: 88 }}
          />
          <Choice
            label={t('rules:builder.unit')}
            value={condition.unit}
            onChange={(unit) => {
              onChange({ ...condition, unit: unit === 'hours' ? 'hours' : 'days' });
            }}
          >
            <option value="hours">{t('rules:units.hours')}</option>
            <option value="days">{t('rules:units.days')}</option>
          </Choice>
        </Box>
      );
    }
    if (kind === 'text') {
      return (
        <TextField
          size="small"
          value={condition.values[0] ?? ''}
          onChange={(event) => {
            onChange({ ...condition, values: [event.target.value] });
          }}
          slotProps={{ htmlInput: { dir: 'auto', 'aria-label': t('rules:builder.text') } }}
          fullWidth
        />
      );
    }
    if (condition.operator === 'any_of') {
      return (
        <ValueChips
          values={condition.values}
          choices={choices}
          onChange={(values) => {
            onChange({ ...condition, values });
          }}
        />
      );
    }
    return (
      <Choice
        label={t('rules:builder.value')}
        value={condition.values[0] ?? ''}
        onChange={(value) => {
          onChange({ ...condition, values: value === '' ? [] : [value] });
        }}
        sx={{ width: '100%' }}
      >
        <option value="">{t('rules:builder.choose')}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Choice>
    );
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 160px) minmax(0, 140px) minmax(0, 1fr) 28px',
        gap: 2,
        alignItems: 'center',
        paddingBlock: 2,
        borderBlockStart: `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Choice
        label={t('rules:builder.field')}
        value={fieldValue(condition)}
        onChange={(value) => {
          if (value.startsWith(CUSTOM_PREFIX)) {
            onChange(withField(condition, 'custom_field', value.slice(CUSTOM_PREFIX.length)));
            return;
          }
          const field = ruleConditionFieldSchema.safeParse(value);
          if (field.success) {
            onChange(withField(condition, field.data));
          }
        }}
      >
        {ruleConditionFieldSchema.options
          .filter((field) => field !== 'custom_field')
          .map((field) => (
            <option key={field} value={field}>
              {t(`rules:fields.${field}`)}
            </option>
          ))}
        {(options?.customFields ?? []).map((field) => (
          <option key={field.key} value={`${CUSTOM_PREFIX}${field.key}`}>
            {text.field({ field: 'custom_field', key: field.key })}
          </option>
        ))}
      </Choice>
      <Choice
        label={t('rules:builder.operator')}
        value={condition.operator}
        onChange={(value) => {
          const operator = ruleOperatorSchema.safeParse(value);
          if (operator.success) {
            onChange(withOperator(condition, operator.data));
          }
        }}
      >
        {RULE_OPERATORS_BY_FIELD[condition.field].map((operator) => (
          <option key={operator} value={operator}>
            {t(`rules:operators.${operator}`)}
          </option>
        ))}
      </Choice>
      <Box sx={{ minWidth: 0 }}>{valueEditor()}</Box>
      <IconButton
        size="small"
        aria-label={t('rules:builder.removeCondition', {
          condition: `${described} ${t(`rules:operators.${condition.operator}`)}`,
        })}
        onClick={onRemove}
        sx={{ width: 28, height: 28 }}
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

/** "Is any of": the picked values as removable chips, and a select to add one more. */
function ValueChips({
  values,
  choices,
  onChange,
}: {
  readonly values: readonly string[];
  readonly choices: readonly ValueOption[];
  readonly onChange: (values: string[]) => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const remaining = choices.filter((choice) => !values.includes(choice.value));

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
      {values.map((value) => {
        const label = choices.find((choice) => choice.value === value)?.label ?? value;
        return (
          <Box
            key={value}
            component="span"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              height: 24,
              paddingInlineStart: 2,
              borderRadius: '6px',
              border: `1px solid ${tokens['border.strong']}`,
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {label}
            <IconButton
              size="small"
              aria-label={t('rules:builder.removeValue', { value: label })}
              onClick={() => {
                onChange(values.filter((candidate) => candidate !== value));
              }}
              sx={{ width: 20, height: 20 }}
            >
              <X size={12} aria-hidden="true" />
            </IconButton>
          </Box>
        );
      })}
      {remaining.length === 0 ? null : (
        <Choice
          label={t('rules:builder.addValue')}
          value=""
          onChange={(value) => {
            if (value !== '') {
              onChange([...values, value]);
            }
          }}
          sx={{ minWidth: 120 }}
        >
          <option value="">{t('rules:builder.addValueOption')}</option>
          {remaining.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Choice>
      )}
    </Box>
  );
}
