import { MAX_MACRO_ACTIONS, type MacroActionType, type TicketStatus } from '@helpdock/schemas';
import { Box, Button, IconButton, MenuItem, TextField, Typography } from '@mui/material';
import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { statusName } from '../../tickets/format.js';
import type { DraftAction } from './macro-draft.js';

/**
 * The Actions fieldset of a macro (artboard `AdminAutomationMacros`): one row
 * per action, each two selects and a remove button, and "Add action" below.
 *
 * The second select's options depend on the first. An assignee is offered as
 * "the agent applying it", "unassigned", the department's teams (handed to its
 * rotation) and its people; an item shared with every department offers only
 * the first two, because a named person or team belongs to one department.
 */

const ACTION_TYPES: readonly MacroActionType[] = [
  'set_status',
  'set_priority',
  'add_tag',
  'remove_tag',
  'assign',
];

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export interface ActionChoices {
  readonly statuses: readonly TicketStatus[];
  readonly tags: readonly {
    readonly id: string;
    readonly name: string;
    readonly nameAr: string | null;
  }[];
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly people: readonly { readonly id: string; readonly name: string }[];
}

export function MacroActionsField({
  actions,
  choices,
  disabled,
  onChange,
}: {
  readonly actions: readonly DraftAction[];
  readonly choices: ActionChoices;
  readonly disabled: boolean;
  onChange(actions: readonly DraftAction[]): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  const replace = (index: number, next: DraftAction | null): void => {
    onChange(
      next === null
        ? actions.filter((_action, at) => at !== index)
        : actions.map((action, at) => (at === index ? next : action)),
    );
  };

  const options = (type: MacroActionType): { value: string; label: string }[] => {
    switch (type) {
      case 'set_status':
        return choices.statuses.map((status) => ({
          value: status.id,
          label: statusName(status, locale),
        }));
      case 'set_priority':
        return PRIORITIES.map((priority) => ({
          value: priority,
          label: t(`tickets:priority.${priority}`),
        }));
      case 'add_tag':
      case 'remove_tag':
        return choices.tags.map((tag) => ({
          value: tag.id,
          label: locale === 'ar' && tag.nameAr !== null ? tag.nameAr : tag.name,
        }));
      case 'assign':
        return [
          { value: 'self', label: t('macros:actions.assignee.self') },
          ...choices.teams.map((team) => ({
            value: `team:${team.id}`,
            label: t('macros:actions.assignee.team', { team: team.name }),
          })),
          ...choices.people.map((person) => ({ value: `user:${person.id}`, label: person.name })),
          { value: 'unassigned', label: t('macros:actions.assignee.unassigned') },
        ];
    }
  };

  return (
    <Box
      component="fieldset"
      disabled={disabled}
      sx={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 2, minWidth: 0 }}
    >
      <Box component="legend" sx={{ padding: 0, marginBlockEnd: 2 }}>
        <Typography component="span" sx={{ fontSize: 14, fontWeight: 600, display: 'block' }}>
          {t('macros:actions.legend')}
        </Typography>
        <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
          {t('macros:actions.caption')}
        </Typography>
      </Box>

      {actions.map((action, index) => {
        const position = index + 1;
        return (
          // Rows have no identity of their own until saved; the position is it.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <Box key={index} sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <TextField
              select
              size="small"
              value={action.type}
              onChange={(event) => {
                replace(index, { type: event.target.value as MacroActionType, value: '' });
              }}
              slotProps={{ htmlInput: { 'aria-label': t('macros:actions.type', { position }) } }}
              sx={{ minWidth: 160 }}
            >
              {ACTION_TYPES.map((type) => (
                <MenuItem key={type} value={type}>
                  {t(`macros:actions.types.${type}`)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              value={action.value}
              onChange={(event) => {
                replace(index, { ...action, value: event.target.value });
              }}
              slotProps={{
                htmlInput: {
                  'aria-label': t(`macros:actions.value.${action.type}`, { position }),
                },
              }}
              sx={{ flex: 1, minWidth: 0 }}
            >
              {options(action.type).map((option) => (
                <MenuItem key={option.value} value={option.value}>
                  {option.label}
                </MenuItem>
              ))}
            </TextField>
            <IconButton
              size="small"
              aria-label={t('macros:actions.remove', { position })}
              onClick={() => {
                replace(index, null);
              }}
            >
              <X size={16} aria-hidden="true" />
            </IconButton>
          </Box>
        );
      })}

      <Box>
        <Button
          variant="text"
          size="small"
          startIcon={<Plus size={16} aria-hidden="true" />}
          disabled={disabled || actions.length >= MAX_MACRO_ACTIONS}
          onClick={() => {
            onChange([...actions, { type: 'set_status', value: '' }]);
          }}
        >
          {t('macros:actions.add')}
        </Button>
      </Box>
    </Box>
  );
}
