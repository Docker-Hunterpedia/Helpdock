import type {
  AssignableAgent,
  Department,
  TagSummary,
  Team,
  TicketStatus,
} from '@helpdock/schemas';
import { BULK_ME, ticketPrioritySchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Divider,
  ListSubheader,
  Menu,
  MenuItem,
  type MenuProps,
  Typography,
} from '@mui/material';
import { useQueries } from '@tanstack/react-query';
import { Ellipsis } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { useTicketingApi, useTicketsApi } from '../../../auth/session.tsx';
import type { BulkChoice } from '../../../tickets/bulk.js';
import { ticketKeys } from '../../../tickets/keys.js';
import { tagLabel } from '../../../tickets/tags.js';
import { AssigneePopover } from '../assignee-picker.tsx';
import { statusName } from '../format.js';
import { SnoozeMenu } from '../snooze/snooze-control.tsx';

/**
 * The bar that replaces the list's footer while rows are ticked
 * (`Admin/Tickets-Bulk`, M14-04): the count, then Status, Close, Assign, Team,
 * Department, Tags, Priority and Snooze, More (set a field, wake, mark spam)
 * and Clear. Choosing anything hands a {@link BulkChoice} to the caller, which
 * previews it; the bar changes nothing itself.
 *
 * Each button opens the picker the details panel uses where there is one — the
 * assignee list and the snooze menu are the very components — and a plain menu
 * where the panel uses a select. The people and teams on offer are those of the
 * departments the ticked tickets are in, so an Agent, who may not read the whole
 * staff list, can still assign to the people who can take these tickets.
 */

type MenuName =
  | 'status'
  | 'assignee'
  | 'team'
  | 'department'
  | 'tags'
  | 'priority'
  | 'snooze'
  | 'more';

const STALE_MS = 30_000;

export interface BulkBarProps {
  readonly brandId: string;
  readonly count: number;
  /** One of the ticked tickets, which the snooze presets are read against. */
  readonly firstTicketId: string;
  /** The departments the ticked tickets are in. */
  readonly departmentIds: readonly string[];
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly tags: readonly TagSummary[];
  /** A preview or an apply is out; the buttons wait. */
  readonly busy: boolean;
  onChoose(choice: BulkChoice): void;
  onMoreField(): void;
  onClear(): void;
}

export function BulkBar({
  brandId,
  count,
  firstTicketId,
  departmentIds,
  statuses,
  departments,
  tags,
  busy,
  onChoose,
  onMoreField,
  onClear,
}: BulkBarProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const id = useId();
  const [open, setOpen] = useState<{ name: MenuName; anchor: HTMLElement } | null>(null);
  const close = (): void => {
    setOpen(null);
  };
  const anchorOf = (name: MenuName): HTMLElement | null =>
    open?.name === name ? open.anchor : null;
  const opener = (name: MenuName) => ({
    'aria-haspopup': name === 'assignee' ? ('listbox' as const) : ('menu' as const),
    'aria-expanded': open?.name === name,
    disabled: busy,
    onClick: (event: { currentTarget: HTMLElement }) => {
      setOpen({ name, anchor: event.currentTarget });
    },
  });

  const { agents, loadCap, agentsFailed, teams, teamsFailed } = useBulkOptions(
    brandId,
    departmentIds,
    open?.name === 'assignee',
    open?.name === 'team',
  );

  const pick = (choice: BulkChoice) => () => {
    close();
    onChoose(choice);
  };

  return (
    <Box
      role="toolbar"
      aria-label={t('tickets:bulk.bar.label')}
      aria-busy={busy}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1,
        paddingBlock: 1.5,
        paddingInline: 3,
        borderRadius: '10px',
        backgroundColor: tokens['bg.surface'],
        border: `1px solid ${tokens['border.default']}`,
        boxShadow: 2,
        width: 'max-content',
        maxWidth: '100%',
      }}
    >
      <Typography
        component="span"
        variant="bodyStrong"
        sx={{ marginInlineEnd: 2, whiteSpace: 'nowrap' }}
      >
        {busy ? t('tickets:bulk.bar.working') : t('tickets:bulk.bar.count', { count })}
      </Typography>

      <Button size="small" variant="text" color="inherit" {...opener('status')}>
        {t('tickets:bulk.bar.status')}
      </Button>
      <Button
        size="small"
        variant="text"
        color="inherit"
        disabled={busy}
        onClick={() => {
          onChoose({ kind: 'close' });
        }}
      >
        {t('tickets:bulk.bar.close')}
      </Button>
      <Button size="small" variant="text" color="inherit" {...opener('assignee')}>
        {t('tickets:bulk.bar.assign')}
      </Button>
      <Button size="small" variant="text" color="inherit" {...opener('team')}>
        {t('tickets:bulk.bar.team')}
      </Button>
      <Button size="small" variant="text" color="inherit" {...opener('department')}>
        {t('tickets:bulk.bar.department')}
      </Button>
      <Button size="small" variant="text" color="inherit" {...opener('tags')}>
        {t('tickets:bulk.bar.tags')}
      </Button>
      <Button size="small" variant="text" color="inherit" {...opener('priority')}>
        {t('tickets:bulk.bar.priority')}
      </Button>
      <Button size="small" variant="text" color="inherit" {...opener('snooze')}>
        {t('tickets:bulk.bar.snooze')}
      </Button>
      <Button
        size="small"
        variant="text"
        color="inherit"
        startIcon={<Ellipsis size={16} aria-hidden="true" />}
        {...opener('more')}
      >
        {t('tickets:bulk.bar.more')}
      </Button>
      <Button size="small" variant="outlined" onClick={onClear} sx={{ marginInlineStart: 'auto' }}>
        {t('tickets:bulk.bar.clear')}
      </Button>

      <ChoiceMenu anchor={anchorOf('status')} label={t('tickets:bulk.menu.status')} onClose={close}>
        {statuses
          // Snoozed is entered through Snooze, which asks for a time.
          .filter((status) => status.isSnoozed !== true)
          .map((status) => (
            <MenuItem key={status.id} onClick={pick({ kind: 'status', statusId: status.id })}>
              {statusName(status, locale)}
            </MenuItem>
          ))}
      </ChoiceMenu>

      <ChoiceMenu
        anchor={anchorOf('priority')}
        label={t('tickets:bulk.menu.priority')}
        onClose={close}
      >
        {ticketPrioritySchema.options.map((priority) => (
          <MenuItem key={priority} onClick={pick({ kind: 'priority', priority })}>
            {t(`tickets:priority.${priority}`)}
          </MenuItem>
        ))}
      </ChoiceMenu>

      <ChoiceMenu
        anchor={anchorOf('department')}
        label={t('tickets:bulk.menu.department')}
        onClose={close}
      >
        {departments.map((department) => (
          <MenuItem
            key={department.id}
            onClick={pick({ kind: 'department', departmentId: department.id })}
          >
            {department.name}
          </MenuItem>
        ))}
      </ChoiceMenu>

      <ChoiceMenu anchor={anchorOf('team')} label={t('tickets:bulk.menu.team')} onClose={close}>
        <MenuItem onClick={pick({ kind: 'team', teamId: null })}>
          {t('tickets:bulk.menu.noTeam')}
        </MenuItem>
        {teams.map((team) => (
          <MenuItem key={team.id} onClick={pick({ kind: 'team', teamId: team.id })}>
            {team.name}
          </MenuItem>
        ))}
        {teamsFailed ? (
          <MenuItem disabled sx={{ whiteSpace: 'normal' }}>
            {t('tickets:bulk.menu.teamsFailed')}
          </MenuItem>
        ) : null}
      </ChoiceMenu>

      <ChoiceMenu anchor={anchorOf('tags')} label={t('tickets:bulk.menu.tags')} onClose={close}>
        {tags.length === 0 ? (
          <MenuItem disabled>{t('tickets:bulk.menu.noTags')}</MenuItem>
        ) : (
          [
            <ListSubheader key="add" component="div" sx={{ lineHeight: '28px' }}>
              {t('tickets:bulk.menu.addTag')}
            </ListSubheader>,
            ...tags.map((tag) => (
              <MenuItem
                key={`add-${tag.id}`}
                onClick={pick({ kind: 'tags', addTagIds: [tag.id], removeTagIds: [] })}
              >
                {tagLabel(tag, locale)}
              </MenuItem>
            )),
            <Divider key="divider" />,
            <ListSubheader key="remove" component="div" sx={{ lineHeight: '28px' }}>
              {t('tickets:bulk.menu.removeTag')}
            </ListSubheader>,
            ...tags.map((tag) => (
              <MenuItem
                key={`remove-${tag.id}`}
                onClick={pick({ kind: 'tags', addTagIds: [], removeTagIds: [tag.id] })}
              >
                {tagLabel(tag, locale)}
              </MenuItem>
            )),
          ]
        )}
      </ChoiceMenu>

      <ChoiceMenu anchor={anchorOf('more')} label={t('tickets:bulk.menu.more')} onClose={close}>
        <MenuItem
          onClick={() => {
            close();
            onMoreField();
          }}
        >
          {t('tickets:bulk.bar.setField')}
        </MenuItem>
        <MenuItem onClick={pick({ kind: 'snooze', until: null })}>
          {t('tickets:bulk.bar.wake')}
        </MenuItem>
        <MenuItem onClick={pick({ kind: 'spam' })}>{t('tickets:bulk.bar.spam')}</MenuItem>
      </ChoiceMenu>

      <AssigneePopover
        anchor={anchorOf('assignee')}
        listId={`${id}-assignee`}
        selectedId={undefined}
        agents={agents}
        loadCap={loadCap}
        unavailable={agentsFailed}
        footer={t('tickets:bulk.menu.assignFooter')}
        leading={(choose) => (
          <MenuItem
            role="option"
            aria-selected={false}
            onClick={() => {
              choose(BULK_ME);
            }}
          >
            {t('tickets:bulk.menu.assignMe')}
          </MenuItem>
        )}
        onClose={close}
        onChoose={(next) => {
          onChoose({ kind: 'assignee', assigneeId: next });
        }}
      />

      <SnoozeMenu
        id={`${id}-snooze`}
        brandId={brandId}
        ticketId={firstTicketId}
        anchor={anchorOf('snooze')}
        busy={busy}
        onClose={close}
        onSnooze={(until) => {
          onChoose({ kind: 'snooze', until });
        }}
      />
    </Box>
  );
}

function ChoiceMenu({
  anchor,
  label,
  onClose,
  children,
}: {
  readonly anchor: HTMLElement | null;
  readonly label: string;
  readonly children: MenuProps['children'];
  onClose(): void;
}): ReactNode {
  return (
    <Menu
      anchorEl={anchor}
      open={anchor !== null}
      onClose={onClose}
      // Opens above the bar, which sits at the bottom of the list.
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slotProps={{
        list: { 'aria-label': label, dense: true },
        paper: { sx: { minWidth: 200, maxHeight: 360 } },
      }}
    >
      {children}
    </Menu>
  );
}

/**
 * The people and the teams of the departments the ticked tickets are in,
 * read only while the menu that needs them is open (and cached for a moment).
 */
function useBulkOptions(
  brandId: string,
  departmentIds: readonly string[],
  wantAgents: boolean,
  wantTeams: boolean,
): {
  readonly agents: readonly AssignableAgent[];
  readonly loadCap: number | null;
  readonly agentsFailed: boolean;
  readonly teams: readonly Team[];
  readonly teamsFailed: boolean;
} {
  const tickets = useTicketsApi();
  const ticketing = useTicketingApi();

  const people = useQueries({
    queries: departmentIds.map((departmentId) => ({
      queryKey: ticketKeys.assignable(brandId, departmentId),
      queryFn: () => tickets.assignable(brandId, departmentId),
      enabled: wantAgents,
      staleTime: STALE_MS,
      retry: false,
    })),
  });
  const groups = useQueries({
    queries: departmentIds.map((departmentId) => ({
      queryKey: ['teams', brandId, departmentId],
      queryFn: () => ticketing.teams(brandId, departmentId),
      enabled: wantTeams,
      staleTime: STALE_MS,
      retry: false,
    })),
  });

  return useMemo(() => {
    const byUser = new Map<string, AssignableAgent>();
    for (const result of people) {
      for (const agent of result.data?.agents ?? []) {
        byUser.set(agent.userId, byUser.get(agent.userId) ?? agent);
      }
    }
    const caps = people.flatMap((result) => (result.data ? [result.data.loadCap] : []));
    const uniform = caps.length > 0 && caps.every((cap) => cap === caps[0]);
    const byTeam = new Map<string, Team>();
    for (const result of groups) {
      for (const team of result.data?.teams ?? []) {
        byTeam.set(team.id, team);
      }
    }

    return {
      agents: [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name)),
      // Departments may cap differently; the cap is shown only when they agree.
      loadCap: uniform ? (caps[0] ?? null) : null,
      agentsFailed: people.some((result) => result.isError),
      teams: [...byTeam.values()],
      teamsFailed: groups.some((result) => result.isError),
    };
  }, [people, groups]);
}
