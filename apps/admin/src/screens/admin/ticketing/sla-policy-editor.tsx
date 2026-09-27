import type {
  SlaAction,
  SlaCondition,
  SlaEscalationStep,
  SlaTimeMode,
  TicketPriority,
} from '@helpdock/schemas';
import { SLA_BREACH_PERCENT, SLA_PRIORITIES } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Radio,
  TextField,
  Typography,
} from '@mui/material';
import {
  ArrowUpCircle,
  Bell,
  CircleAlert,
  Flag,
  Plus,
  Tag as TagIcon,
  Trash2,
  TriangleAlert,
  UserRoundPlus,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { PriorityBadge } from '../../tickets/badges.tsx';
import { type ActionPick, ActionPickerDialog, type PickOptions } from './sla-action-picker.tsx';
import { type DraftIssues, issueCount, type PolicyDraft, type TargetUnit } from './sla-draft.js';

/**
 * The policy editor of the SLAs tab (M3-02, artboard `Admin/Ticketing-SLAs`):
 * name, conditions, how time is counted, the targets per priority and the
 * escalation steps, with one Save at the bottom that recomputes the clocks on
 * the api.
 *
 * DESIGN §6.3 ConditionRow and EscalationStep are drawn here: a condition is
 * three controls and a delete; a step is a percent, its actions as removable
 * chips, and "Add action". The step at 100 % shows "Breach recorded" first,
 * because the breach is recorded whatever the step's actions are.
 */
export function SlaPolicyEditor({
  draft,
  issues,
  showIssues,
  caption,
  runningTickets,
  options,
  busy,
  changed,
  onChange,
  onDelete,
  onDiscard,
  onSave,
}: {
  readonly draft: PolicyDraft;
  readonly issues: DraftIssues;
  /** Issues are named once somebody tried to save, or touched the field. */
  readonly showIssues: boolean;
  /** "Policy 2 of 3 · last changed by …", or null for a policy not saved yet. */
  readonly caption: string | null;
  readonly runningTickets: number;
  readonly options: PickOptions;
  readonly busy: boolean;
  readonly changed: boolean;
  onChange(draft: PolicyDraft): void;
  onDelete: (() => void) | null;
  onDiscard(): void;
  onSave(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const nameId = useId();
  const count = issueCount(issues);

  const section = {
    paddingBlock: 4,
    paddingInline: 5,
    borderBlockStart: `1px solid ${tokens['border.default']}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  } as const;

  return (
    <Box
      component="form"
      aria-label={t('ticketing:slas.editor.form')}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box
        sx={{ paddingBlock: 4, paddingInline: 5, display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <Typography component="label" htmlFor={nameId} variant="body2" sx={{ fontWeight: 500 }}>
          {t('ticketing:slas.editor.name')}{' '}
          <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('ticketing:slas.editor.required')}
          </Box>
        </Typography>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            id={nameId}
            size="small"
            fullWidth
            value={draft.name}
            error={showIssues && issues.name}
            helperText={
              showIssues && issues.name ? t('ticketing:slas.editor.nameMissing') : undefined
            }
            onChange={(event) => {
              onChange({ ...draft, name: event.target.value });
            }}
            slotProps={{ htmlInput: { maxLength: 120 } }}
          />
          {onDelete === null ? null : (
            <Button
              variant="outlined"
              color="error"
              startIcon={<Trash2 size={16} aria-hidden="true" />}
              disabled={busy}
              onClick={onDelete}
              sx={{ flexShrink: 0, alignSelf: 'flex-start' }}
            >
              {t('ticketing:slas.editor.delete')}
            </Button>
          )}
        </Box>
        {caption === null ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {caption}
          </Typography>
        )}
      </Box>

      <Box component="section" aria-labelledby="sla-applies" sx={section}>
        <Box>
          <Typography variant="bodyStrong" component="h3" id="sla-applies">
            {t('ticketing:slas.editor.appliesTo')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:slas.editor.appliesToCaption')}
          </Typography>
        </Box>
        {draft.conditions.map((condition, index) => (
          <ConditionRow
            key={condition.field}
            condition={condition}
            options={options}
            onChange={(next) => {
              onChange({
                ...draft,
                conditions: draft.conditions.map((existing, at) =>
                  at === index ? next : existing,
                ),
              });
            }}
            onRemove={() => {
              onChange({ ...draft, conditions: draft.conditions.filter((_c, at) => at !== index) });
            }}
          />
        ))}
        {draft.conditions.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:slas.editor.noConditions')}
          </Typography>
        ) : null}
        {draft.conditions.length < 2 ? (
          <Button
            variant="text"
            size="small"
            startIcon={<Plus size={16} aria-hidden="true" />}
            sx={{ alignSelf: 'flex-start' }}
            onClick={() => {
              const field = draft.conditions.some((condition) => condition.field === 'department')
                ? 'priority'
                : 'department';
              const added: SlaCondition =
                field === 'department'
                  ? {
                      field,
                      operator: 'any',
                      values: options.departments.slice(0, 1).map((d) => d.id),
                    }
                  : { field, operator: 'any', values: ['high', 'urgent'] };
              onChange({ ...draft, conditions: [...draft.conditions, added] });
            }}
          >
            {t('ticketing:slas.editor.addCondition')}
          </Button>
        ) : null}
      </Box>

      <Box component="section" aria-labelledby="sla-time" sx={section}>
        <Typography variant="bodyStrong" component="h3" id="sla-time">
          {t('ticketing:slas.editor.timeMode')}
        </Typography>
        <Box
          role="radiogroup"
          aria-labelledby="sla-time"
          sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 3 }}
        >
          {(['business', 'calendar'] as const satisfies readonly SlaTimeMode[]).map((mode) => {
            const selected = draft.timeMode === mode;
            return (
              <Box
                key={mode}
                component="label"
                sx={{
                  display: 'flex',
                  gap: 2,
                  padding: 3,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  border: `${selected ? 2 : 1}px solid ${selected ? tokens['action.primary'] : tokens['border.default']}`,
                  backgroundColor: selected ? tokens['action.primary.tint'] : undefined,
                }}
              >
                <Radio
                  size="small"
                  checked={selected}
                  value={mode}
                  onChange={() => {
                    onChange({ ...draft, timeMode: mode });
                  }}
                  sx={{ padding: 0, alignSelf: 'flex-start' }}
                />
                <Box>
                  <Typography variant="bodyStrong" component="span" sx={{ display: 'block' }}>
                    {t(`ticketing:slas.editor.${mode}`)}
                  </Typography>
                  <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
                    {t(`ticketing:slas.editor.${mode}Hint`)}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box component="section" aria-labelledby="sla-targets" sx={section}>
        <Box>
          <Typography variant="bodyStrong" component="h3" id="sla-targets">
            {t('ticketing:slas.editor.targets')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:slas.editor.targetsCaption')}
          </Typography>
        </Box>
        <TargetsTable draft={draft} issues={showIssues ? issues : null} onChange={onChange} />
      </Box>

      <Box component="section" aria-labelledby="sla-steps" sx={section}>
        <Box>
          <Typography variant="bodyStrong" component="h3" id="sla-steps">
            {t('ticketing:slas.editor.steps')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:slas.editor.stepsCaption')}
          </Typography>
        </Box>
        <Box
          sx={{
            borderRadius: '8px',
            border: `1px solid ${tokens['border.default']}`,
            overflow: 'hidden',
          }}
        >
          {draft.escalation.map((step, index) => (
            <EscalationStepRow
              // biome-ignore lint/suspicious/noArrayIndexKey: a step's percent changes as it is typed; its place in the list does not.
              key={index}
              step={step}
              invalid={showIssues && issues.steps.includes(index)}
              options={options}
              onChange={(next) => {
                onChange({
                  ...draft,
                  escalation: draft.escalation.map((existing, at) =>
                    at === index ? next : existing,
                  ),
                });
              }}
              onRemove={() => {
                onChange({
                  ...draft,
                  escalation: draft.escalation.filter((_s, at) => at !== index),
                });
              }}
            />
          ))}
          {draft.escalation.length === 0 ? (
            <Typography variant="body2" sx={{ padding: 3, color: 'text.secondary' }}>
              {t('ticketing:slas.editor.noSteps')}
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<Plus size={16} aria-hidden="true" />}
            disabled={draft.escalation.length >= 10}
            onClick={() => {
              const last = Math.max(0, ...draft.escalation.map((step) => step.atPercent));
              onChange({
                ...draft,
                escalation: [
                  ...draft.escalation,
                  {
                    atPercent: last >= 100 ? last + 50 : Math.min(100, last + 25),
                    actions: [{ type: 'notify', recipient: { kind: 'department_leads' } }],
                  },
                ],
              });
            }}
          >
            {t('ticketing:slas.editor.addStep')}
          </Button>
          <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1 }}>
            {t('ticketing:slas.editor.timerKeys')}
          </Typography>
        </Box>
      </Box>

      <Box
        sx={{
          ...section,
          backgroundColor: tokens['bg.canvas'],
          borderEndStartRadius: '10px',
          borderEndEndRadius: '10px',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            gap: 2,
            padding: 3,
            borderRadius: '8px',
            border: `1px solid ${tokens['status.warning']}`,
            backgroundColor: tokens['status.warning.tint'],
            color: tokens['status.warning.text'],
          }}
        >
          <TriangleAlert
            size={16}
            aria-hidden="true"
            style={{ flexShrink: 0, marginBlockStart: 2 }}
          />
          <Typography variant="body2">
            {t('ticketing:slas.editor.recompute', { count: runningTickets })}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography variant="body2" aria-live="polite" sx={{ flex: 1, color: 'text.secondary' }}>
            {showIssues && count > 0 ? t('ticketing:slas.editor.issues', { count }) : ''}
          </Typography>
          <Button variant="text" disabled={!changed || busy} onClick={onDiscard}>
            {t('ticketing:slas.editor.discard')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || !changed}>
            {t('ticketing:slas.editor.save')}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

// ------------------------------------------------------------------ conditions

function ConditionRow({
  condition,
  options,
  onChange,
  onRemove,
}: {
  readonly condition: SlaCondition;
  readonly options: PickOptions;
  onChange(condition: SlaCondition): void;
  onRemove(): void;
}): ReactNode {
  const t = useT();
  const fieldName = t(`ticketing:slas.editor.field.${condition.field}`);
  const choices: readonly { id: string; label: string }[] =
    condition.field === 'department'
      ? options.departments.map((department) => ({ id: department.id, label: department.name }))
      : SLA_PRIORITIES.map((priority) => ({
          id: priority,
          label: t(`tickets:priority.${priority}`),
        }));

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '140px 140px minmax(0, 1fr) 40px' },
        gap: 2,
        alignItems: 'center',
      }}
    >
      <TextField
        size="small"
        value={fieldName}
        slotProps={{
          htmlInput: { readOnly: true, 'aria-label': t('ticketing:slas.editor.fieldLabel') },
        }}
      />
      <TextField
        select
        size="small"
        value={condition.operator}
        slotProps={{
          htmlInput: {
            'aria-label': t('ticketing:slas.editor.operatorLabel', { field: fieldName }),
          },
        }}
        onChange={(event) => {
          onChange({
            ...condition,
            operator: event.target.value === 'none' ? 'none' : 'any',
          } as SlaCondition);
        }}
      >
        <MenuItem value="any">{t('ticketing:slas.editor.anyOf')}</MenuItem>
        <MenuItem value="none">{t('ticketing:slas.editor.noneOf')}</MenuItem>
      </TextField>
      <TextField
        select
        size="small"
        value={condition.values as string[]}
        slotProps={{
          select: {
            multiple: true,
            renderValue: (selected) => (
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {(selected as string[]).map((id) => (
                  <Chip
                    key={id}
                    size="small"
                    label={choices.find((choice) => choice.id === id)?.label ?? id}
                  />
                ))}
              </Box>
            ),
          },
          htmlInput: { 'aria-label': t('ticketing:slas.editor.valuesLabel', { field: fieldName }) },
        }}
        onChange={(event) => {
          const raw = event.target.value as unknown;
          const values = (Array.isArray(raw) ? raw : String(raw).split(',')) as string[];
          if (values.length > 0) {
            onChange({ ...condition, values } as SlaCondition);
          }
        }}
      >
        {choices.map((choice) => (
          <MenuItem key={choice.id} value={choice.id}>
            {choice.label}
          </MenuItem>
        ))}
      </TextField>
      <IconButton
        size="small"
        aria-label={t('ticketing:slas.editor.removeCondition', { field: fieldName })}
        onClick={onRemove}
      >
        <Trash2 size={16} aria-hidden="true" />
      </IconButton>
    </Box>
  );
}

// --------------------------------------------------------------------- targets

function TargetsTable({
  draft,
  issues,
  onChange,
}: {
  readonly draft: PolicyDraft;
  readonly issues: DraftIssues | null;
  onChange(draft: PolicyDraft): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const columns = { xs: '1fr', md: '120px minmax(0, 1fr) minmax(0, 1fr)' };

  const cell = (priority: TicketPriority, clock: 'firstResponse' | 'resolution') => {
    const field = draft.targets[priority][clock];
    const invalid = issues?.targets.includes(`${priority}.${clock}`) === true;
    const clockName = t(`ticketing:slas.editor.${clock}`);
    const set = (next: Partial<typeof field>) => {
      onChange({
        ...draft,
        targets: {
          ...draft.targets,
          [priority]: { ...draft.targets[priority], [clock]: { ...field, ...next } },
        },
      });
    };

    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            value={field.value}
            error={invalid}
            onChange={(event) => {
              set({ value: event.target.value });
            }}
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                'aria-label': t('ticketing:slas.editor.targetLabel', {
                  clock: clockName,
                  priority: t(`tickets:priority.${priority}`),
                }),
                'aria-invalid': invalid,
              },
            }}
            sx={{ inlineSize: 80 }}
          />
          <TextField
            select
            size="small"
            value={field.unit}
            onChange={(event) => {
              set({ unit: event.target.value as TargetUnit });
            }}
            slotProps={{
              htmlInput: {
                'aria-label': t('ticketing:slas.editor.unitLabel', {
                  clock: clockName,
                  priority: t(`tickets:priority.${priority}`),
                }),
              },
            }}
            sx={{ inlineSize: 110 }}
          >
            <MenuItem value="minutes">{t('ticketing:slas.editor.minutes')}</MenuItem>
            <MenuItem value="hours">{t('ticketing:slas.editor.hours')}</MenuItem>
          </TextField>
        </Box>
        {invalid ? (
          <Typography variant="caption" sx={{ color: tokens['status.danger'] }}>
            {t('ticketing:slas.editor.targetMissing')}
          </Typography>
        ) : null}
      </Box>
    );
  };

  return (
    <Box
      role="table"
      aria-labelledby="sla-targets"
      sx={{
        borderRadius: '8px',
        border: `1px solid ${tokens['border.default']}`,
        overflow: 'hidden',
      }}
    >
      <Box
        role="row"
        sx={{
          display: 'grid',
          gridTemplateColumns: columns,
          gap: 2,
          paddingInline: 3,
          paddingBlock: 2,
          backgroundColor: tokens['bg.muted'],
        }}
      >
        <Typography role="columnheader" variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:slas.editor.priority')}
        </Typography>
        <Typography role="columnheader" variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:slas.editor.firstResponse')}
        </Typography>
        <Typography role="columnheader" variant="caption" sx={{ color: 'text.secondary' }}>
          {t('ticketing:slas.editor.resolution')}
        </Typography>
      </Box>
      {SLA_PRIORITIES.map((priority) => (
        <Box
          role="row"
          key={priority}
          sx={{
            display: 'grid',
            gridTemplateColumns: columns,
            gap: 2,
            alignItems: 'start',
            paddingInline: 3,
            paddingBlock: 2,
            borderBlockStart: `1px solid ${tokens['border.default']}`,
          }}
        >
          <Box role="cell" sx={{ paddingBlockStart: 1 }}>
            <PriorityBadge priority={priority} />
          </Box>
          <Box role="cell">{cell(priority, 'firstResponse')}</Box>
          <Box role="cell">{cell(priority, 'resolution')}</Box>
        </Box>
      ))}
    </Box>
  );
}

// ------------------------------------------------------------------ escalation

const ACTION_ICONS = {
  notify: Bell,
  reassign: UserRoundPlus,
  raise_priority: ArrowUpCircle,
  add_tag: TagIcon,
  set_escalated: Flag,
} as const;

/** "Notify · Department team leads", "Reassign · Karim Nasser", … */
export const useActionLabel = (options: PickOptions): ((action: SlaAction) => string) => {
  const t = useT();
  const nameOf = (list: readonly { id: string; name: string }[], id: string): string =>
    list.find((entry) => entry.id === id)?.name ?? t('ticketing:slas.actions.unknown');

  return (action) => {
    switch (action.type) {
      case 'notify':
        switch (action.recipient.kind) {
          case 'department_leads':
            return t('ticketing:slas.actions.notifyLeads');
          case 'team':
            return t('ticketing:slas.actions.notifyTeam', {
              name: nameOf(options.teams, action.recipient.teamId),
            });
          case 'user':
            return t('ticketing:slas.actions.notifyUser', {
              name: nameOf(options.people, action.recipient.userId),
            });
        }
        break;
      case 'reassign':
        return t('ticketing:slas.actions.reassign', {
          name: nameOf(options.people, action.userId),
        });
      case 'raise_priority':
        return t('ticketing:slas.actions.raisePriority');
      case 'add_tag':
        return t('ticketing:slas.actions.addTag', { name: nameOf(options.tags, action.tagId) });
      case 'set_escalated':
        return t('ticketing:slas.actions.setEscalated');
    }
    return '';
  };
};

function EscalationStepRow({
  step,
  invalid,
  options,
  onChange,
  onRemove,
}: {
  readonly step: SlaEscalationStep;
  readonly invalid: boolean;
  readonly options: PickOptions;
  onChange(step: SlaEscalationStep): void;
  onRemove(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const label = useActionLabel(options);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [picking, setPicking] = useState<ActionPick | null>(null);
  const add = (action: SlaAction) => {
    onChange({ ...step, actions: [...step.actions, action] });
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '120px minmax(0, 1fr) 40px' },
        gap: 2,
        alignItems: 'start',
        padding: 3,
        borderBlockStart: `1px solid ${tokens['border.default']}`,
        '&:first-of-type': { borderBlockStart: 0 },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TextField
          size="small"
          value={String(step.atPercent)}
          error={invalid}
          onChange={(event) => {
            const value = Number.parseInt(event.target.value.replace(/\D/g, ''), 10);
            onChange({ ...step, atPercent: Number.isNaN(value) ? 0 : Math.min(value, 1000) });
          }}
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              'aria-label': t('ticketing:slas.editor.stepPercent'),
              'aria-invalid': invalid,
            },
          }}
          sx={{ inlineSize: 72 }}
        />
        <Typography variant="body2" aria-hidden="true">
          %
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          {step.atPercent === SLA_BREACH_PERCENT ? (
            <Chip
              size="small"
              icon={<CircleAlert size={14} aria-hidden="true" />}
              label={t('ticketing:slas.editor.breachRecorded')}
              sx={{
                backgroundColor: tokens['status.danger.tint'],
                color: tokens['status.danger.text'],
                border: `1px solid ${tokens['status.danger']}`,
              }}
            />
          ) : null}
          {step.actions.map((action, index) => {
            const Icon = ACTION_ICONS[action.type];
            const text = label(action);
            return (
              <Chip
                // biome-ignore lint/suspicious/noArrayIndexKey: two identical actions are allowed and have nothing else to tell them apart.
                key={index}
                size="small"
                variant="outlined"
                icon={<Icon size={14} aria-hidden="true" />}
                label={text}
                onDelete={() => {
                  onChange({ ...step, actions: step.actions.filter((_a, at) => at !== index) });
                }}
                slotProps={
                  {
                    deleteIcon: {
                      'aria-label': t('ticketing:slas.editor.removeAction', { action: text }),
                    },
                  } as never
                }
              />
            );
          })}
          <Button
            variant="text"
            size="small"
            startIcon={<Plus size={16} aria-hidden="true" />}
            disabled={step.actions.length >= 5}
            onClick={(event) => {
              setMenu(event.currentTarget);
            }}
          >
            {t('ticketing:slas.editor.addAction')}
          </Button>
        </Box>
        {step.atPercent === SLA_BREACH_PERCENT ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('ticketing:slas.editor.breachNote')}
          </Typography>
        ) : null}
        {invalid ? (
          <Typography variant="caption" sx={{ color: tokens['status.danger'] }}>
            {t('ticketing:slas.editor.stepInvalid')}
          </Typography>
        ) : null}
      </Box>

      <IconButton
        size="small"
        aria-label={t('ticketing:slas.editor.removeStep', { percent: step.atPercent })}
        onClick={onRemove}
      >
        <Trash2 size={16} aria-hidden="true" />
      </IconButton>

      <Menu
        anchorEl={menu}
        open={menu !== null}
        onClose={() => {
          setMenu(null);
        }}
      >
        {(
          [
            [
              'notifyLeads',
              Bell,
              () => add({ type: 'notify', recipient: { kind: 'department_leads' } }),
            ],
            ['notifyTeam', Bell, () => setPicking('team')],
            ['notifyUser', Bell, () => setPicking('notifyUser')],
            ['reassign', UserRoundPlus, () => setPicking('reassign')],
            ['raisePriority', ArrowUpCircle, () => add({ type: 'raise_priority' })],
            ['addTag', TagIcon, () => setPicking('tag')],
            ['setEscalated', Flag, () => add({ type: 'set_escalated' })],
          ] as const
        ).map(([key, Icon, run]) => (
          <MenuItem
            key={key}
            onClick={() => {
              setMenu(null);
              run();
            }}
          >
            <ListItemIcon>
              <Icon size={16} aria-hidden="true" />
            </ListItemIcon>
            {t(`ticketing:slas.menu.${key}`)}
          </MenuItem>
        ))}
      </Menu>

      <ActionPickerDialog
        pick={picking}
        options={options}
        onClose={() => {
          setPicking(null);
        }}
        onPick={(action) => {
          setPicking(null);
          add(action);
        }}
      />
    </Box>
  );
}
