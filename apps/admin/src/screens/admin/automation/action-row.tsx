import {
  RULE_NOTE_MAX_LENGTH,
  RULE_NOTIFY_MESSAGE_MAX_LENGTH,
  type RuleAction,
  type RuleActionType,
  type RuleBuilderOptions,
  aiTriageFieldSchema,
  aiTriageModeSchema,
  ticketPrioritySchema,
} from '@helpdock/schemas';
import { Box, Checkbox, IconButton, TextField, Typography } from '@mui/material';
import { GripVertical, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Choice } from './choice.tsx';
import { newAction } from './rule-draft.js';

/**
 * One action of the "Then" list (`AdminRuleBuilder`): its place, what it is,
 * what it acts with, and remove. "Assign to" is one choice with Team, Agent and
 * Round-robin under it, as the artboard draws it, although they are three
 * actions to the api.
 *
 * A canned reply carries `counts_as_response`, off by default, with the hint
 * that says why (DOMAIN-RULES §3.1): the first-response clock is M3-02's, and
 * this box is the only way a rule may stop it.
 */

/** What the action select offers: the api's types, with the three assigns as one. */
const UI_TYPES = [
  'set_status',
  'set_priority',
  'set_field',
  'assign',
  'add_tag',
  'remove_tag',
  'send_canned',
  'add_note',
  'notify',
  'escalate',
  'close',
  'ai_triage',
] as const;
type UiType = (typeof UI_TYPES)[number];

const uiTypeOf = (action: RuleAction): UiType =>
  action.type === 'assign_team' ||
  action.type === 'assign_agent' ||
  action.type === 'assign_round_robin'
    ? 'assign'
    : action.type;

const ASSIGN_TARGETS = ['assign_team', 'assign_agent', 'assign_round_robin'] as const;

/** A notify recipient as one select value. */
const recipientValue = (action: Extract<RuleAction, { type: 'notify' }>): string => {
  const { recipient } = action;
  switch (recipient.kind) {
    case 'team':
      return `team:${recipient.teamId}`;
    case 'user':
      return `user:${recipient.userId}`;
    default:
      return recipient.kind;
  }
};

const recipientOf = (value: string): Extract<RuleAction, { type: 'notify' }>['recipient'] => {
  if (value.startsWith('team:')) {
    return { kind: 'team', teamId: value.slice(5) };
  }
  if (value.startsWith('user:')) {
    return { kind: 'user', userId: value.slice(5) };
  }
  return value === 'assignee' ? { kind: 'assignee' } : { kind: 'department_leads' };
};

export function ActionRow({
  index,
  action,
  options,
  onChange,
  onRemove,
  onMove,
}: {
  readonly index: number;
  readonly action: RuleAction;
  readonly options: RuleBuilderOptions | undefined;
  readonly onChange: (next: RuleAction) => void;
  readonly onRemove: () => void;
  /** -1 for earlier in the list, 1 for later. */
  readonly onMove: (offset: number) => void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const n = index + 1;
  const named = (entry: { name: string; nameAr?: string | null }) =>
    locale === 'ar' && entry.nameAr ? entry.nameAr : entry.name;
  const hintId = `counts-hint-${String(n)}`;

  const pick = (
    label: string,
    value: string,
    entries: readonly { id: string; name: string; nameAr?: string | null }[],
    set: (value: string) => void,
  ): ReactNode => (
    <Choice label={label} value={value} onChange={set}>
      <option value="">{t('rules:builder.choose')}</option>
      {entries.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {named(entry)}
        </option>
      ))}
    </Choice>
  );

  const editor = (): ReactNode => {
    switch (action.type) {
      case 'set_status':
        return pick(
          t('rules:fields.status'),
          action.statusId,
          options?.statuses ?? [],
          (statusId) => {
            onChange({ ...action, statusId });
          },
        );
      case 'set_priority':
        return (
          <Choice
            label={t('rules:fields.priority')}
            value={action.priority}
            onChange={(value) => {
              const priority = ticketPrioritySchema.safeParse(value);
              if (priority.success) {
                onChange({ ...action, priority: priority.data });
              }
            }}
          >
            {ticketPrioritySchema.options.map((priority) => (
              <option key={priority} value={priority}>
                {t(`rules:priorities.${priority}`)}
              </option>
            ))}
          </Choice>
        );
      case 'set_field':
        return (
          <>
            <Choice
              label={t('rules:builder.customField')}
              value={action.key}
              onChange={(key) => {
                onChange({ ...action, key });
              }}
            >
              <option value="">{t('rules:builder.choose')}</option>
              {(options?.customFields ?? []).map((field) => (
                <option key={field.key} value={field.key}>
                  {locale === 'ar' && field.labelAr ? field.labelAr : field.label}
                </option>
              ))}
            </Choice>
            <TextField
              size="small"
              value={action.value ?? ''}
              onChange={(event) => {
                onChange({ ...action, value: event.target.value });
              }}
              slotProps={{ htmlInput: { dir: 'auto', 'aria-label': t('rules:builder.value') } }}
            />
          </>
        );
      case 'assign_team':
      case 'assign_agent':
      case 'assign_round_robin':
        return (
          <>
            <Choice
              label={t('rules:builder.assignTo')}
              value={action.type}
              onChange={(value) => {
                const target = ASSIGN_TARGETS.find((candidate) => candidate === value);
                if (target !== undefined) {
                  onChange(newAction(target));
                }
              }}
            >
              {ASSIGN_TARGETS.map((target) => (
                <option key={target} value={target}>
                  {t(`rules:assignTargets.${target}`)}
                </option>
              ))}
            </Choice>
            {action.type === 'assign_team'
              ? pick(t('rules:fields.team'), action.teamId, options?.teams ?? [], (teamId) => {
                  onChange({ ...action, teamId });
                })
              : null}
            {action.type === 'assign_agent'
              ? pick(t('rules:builder.agent'), action.userId, options?.members ?? [], (userId) => {
                  onChange({ ...action, userId });
                })
              : null}
          </>
        );
      case 'add_tag':
      case 'remove_tag':
        return pick(t('rules:fields.tag'), action.tagId, options?.tags ?? [], (tagId) => {
          onChange({ ...action, tagId });
        });
      case 'send_canned':
        return (
          <>
            {pick(
              t('rules:builder.cannedResponse'),
              action.cannedResponseId,
              options?.cannedResponses ?? [],
              (cannedResponseId) => {
                onChange({ ...action, cannedResponseId });
              },
            )}
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
              {(options?.cannedResponses.length ?? 0) === 0
                ? t('rules:builder.noCanned')
                : t('rules:builder.onChannel')}
            </Typography>
          </>
        );
      case 'add_note':
        return (
          <TextField
            size="small"
            multiline
            minRows={2}
            value={action.body}
            onChange={(event) => {
              onChange({ ...action, body: event.target.value });
            }}
            slotProps={{
              htmlInput: {
                dir: 'auto',
                maxLength: RULE_NOTE_MAX_LENGTH,
                'aria-label': t('rules:builder.note'),
              },
            }}
            sx={{ flex: 1, minWidth: 200 }}
          />
        );
      case 'notify':
        return (
          <>
            <Choice
              label={t('rules:builder.notifyWho')}
              value={recipientValue(action)}
              onChange={(value) => {
                onChange({ ...action, recipient: recipientOf(value) });
              }}
            >
              <option value="department_leads">{t('rules:recipients.department_leads')}</option>
              <option value="assignee">{t('rules:recipients.assignee')}</option>
              {(options?.teams ?? []).map((team) => (
                <option key={team.id} value={`team:${team.id}`}>
                  {t('rules:recipients.teamNamed', { team: team.name })}
                </option>
              ))}
              {(options?.members ?? []).map((member) => (
                <option key={member.id} value={`user:${member.id}`}>
                  {member.name}
                </option>
              ))}
            </Choice>
            <TextField
              size="small"
              value={action.message ?? ''}
              placeholder={t('rules:builder.notifyMessage')}
              onChange={(event) => {
                onChange({
                  ...action,
                  message: event.target.value === '' ? null : event.target.value,
                });
              }}
              slotProps={{
                htmlInput: {
                  dir: 'auto',
                  maxLength: RULE_NOTIFY_MESSAGE_MAX_LENGTH,
                  'aria-label': t('rules:builder.notifyMessage'),
                },
              }}
              sx={{ flex: 1, minWidth: 160 }}
            />
          </>
        );
      case 'ai_triage':
        return (
          <>
            <Choice
              label={t('rules:builder.triageMode')}
              value={action.mode}
              onChange={(value) => {
                const mode = aiTriageModeSchema.safeParse(value);
                if (mode.success) {
                  onChange({ ...action, mode: mode.data });
                }
              }}
            >
              {aiTriageModeSchema.options.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`rules:triageModes.${mode}`)}
                </option>
              ))}
            </Choice>
            <Box
              role="group"
              aria-label={t('rules:builder.triageFields')}
              sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}
            >
              {aiTriageFieldSchema.options.map((field) => (
                <Box
                  key={field}
                  component="label"
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}
                >
                  <Checkbox
                    size="small"
                    checked={action.fields.includes(field)}
                    // The last field stays: a triage that may change nothing is no action.
                    disabled={action.fields.length === 1 && action.fields.includes(field)}
                    onChange={(event) => {
                      onChange({
                        ...action,
                        fields: event.target.checked
                          ? aiTriageFieldSchema.options.filter(
                              (candidate) => candidate === field || action.fields.includes(candidate),
                            )
                          : action.fields.filter((candidate) => candidate !== field),
                      });
                    }}
                    sx={{ padding: 0 }}
                  />
                  <Typography variant="body2">{t(`rules:triageFields.${field}`)}</Typography>
                </Box>
              ))}
            </Box>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        paddingBlock: 3,
        borderBlockStart: index === 0 ? undefined : `1px solid ${tokens['bg.muted']}`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <IconButton
          size="small"
          aria-label={t('rules:builder.reorderAction', { n })}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              onMove(event.key === 'ArrowUp' ? -1 : 1);
            }
          }}
          sx={{ width: 20, height: 28, color: 'text.secondary' }}
        >
          <GripVertical size={16} aria-hidden="true" />
        </IconButton>
        <Typography variant="mono" component="span" sx={{ color: 'text.secondary', width: 16 }}>
          {n}
        </Typography>
        <Choice
          label={t('rules:builder.action', { n })}
          value={uiTypeOf(action)}
          onChange={(value) => {
            const type = UI_TYPES.find((candidate) => candidate === value);
            if (type !== undefined && type !== uiTypeOf(action)) {
              onChange(newAction(type === 'assign' ? 'assign_team' : (type as RuleActionType)));
            }
          }}
        >
          {UI_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`rules:actionTypes.${type}`)}
            </option>
          ))}
        </Choice>
        {editor()}
        <IconButton
          size="small"
          aria-label={t('rules:builder.removeAction', { n })}
          onClick={onRemove}
          sx={{ width: 28, height: 28, marginInlineStart: 'auto' }}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </Box>
      {action.type === 'ai_triage' ? (
        <Typography
          variant="caption"
          sx={{ color: 'text.secondary', fontWeight: 400, paddingInlineStart: 12 }}
        >
          {t('rules:builder.triageHint')}
        </Typography>
      ) : null}
      {action.type === 'send_canned' ? (
        <Box
          component="label"
          sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', paddingInlineStart: 12 }}
        >
          <Checkbox
            size="small"
            checked={action.countsAsResponse ?? false}
            onChange={(event) => {
              onChange({ ...action, countsAsResponse: event.target.checked });
            }}
            slotProps={{ input: { 'aria-describedby': hintId } }}
            sx={{ padding: 0 }}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {t('rules:builder.countsAsResponse')}
            </Typography>
            <Typography
              id={hintId}
              variant="caption"
              sx={{ color: 'text.secondary', fontWeight: 400 }}
            >
              <code>counts_as_response</code> · {t('rules:builder.countsHint')}
            </Typography>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
