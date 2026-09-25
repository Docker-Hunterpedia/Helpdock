import type { Department, TagSummary, TicketStatus, TicketSystemState } from '@helpdock/schemas';
import { ticketPrioritySchema, ticketSystemStateSchema } from '@helpdock/schemas';
import { Box, Button, Chip, Popover, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { activeFilterCount, EMPTY_FILTERS, type WorkspaceFilters } from '../../tickets/views.js';
import { statusName } from './format.js';

/**
 * The Filter button's popover: state, status, priority, assignee, department,
 * tags and SLA, each a row of toggle chips.
 *
 * There is no Apply button. Every choice is written straight into the query
 * string and the list re-reads, which is the same rule the contact screens
 * follow — the URL is the state, so a filtered list is a link a colleague can
 * open and the back button steps through what somebody looked at. On a saved
 * view the change is what raises "Filters changed" (M1-05).
 *
 * Assignee offers two values that are not people: "Assigned to me" and
 * "Unassigned". They are values of the same filter rather than switches of
 * their own, because `assigneeId` is one parameter and two switches would let
 * a person ask for both at once and get nothing. "Me" is sent as `me`, which
 * the api reads as whoever is asking — so a view saved from it means the same
 * to everybody who opens it.
 */

/** Clearing keeps the order: it is not a filter, and the list header shows it. */
const cleared = (filters: WorkspaceFilters): WorkspaceFilters => ({
  ...EMPTY_FILTERS,
  q: filters.q,
  sort: filters.sort,
  direction: filters.direction,
});

const toggle = <T,>(values: readonly T[], value: T): readonly T[] =>
  values.includes(value) ? values.filter((member) => member !== value) : [...values, value];

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Box component="fieldset" sx={{ border: 0, margin: 0, padding: 0 }}>
      <Typography component="legend" variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, marginBlockStart: 2 }}>{children}</Box>
    </Box>
  );
}

function FilterChip({
  label,
  on,
  onToggle,
}: {
  readonly label: string;
  readonly on: boolean;
  onToggle(): void;
}): ReactNode {
  return (
    <Chip
      size="small"
      label={label}
      variant={on ? 'filled' : 'outlined'}
      onClick={onToggle}
      // A chip is a button to the keyboard and a switch to a screen reader:
      // what it says is whether this filter is on, not that it can be pressed.
      role="switch"
      aria-checked={on}
    />
  );
}

export function FilterPopover({
  anchorEl,
  filters,
  statuses,
  departments,
  tags,
  staff,
  viewerId,
  onChange,
  onClose,
}: {
  readonly anchorEl: HTMLElement | null;
  readonly filters: WorkspaceFilters;
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly tags: readonly TagSummary[];
  readonly staff: readonly { readonly userId: string; readonly name: string }[];
  readonly viewerId: string;
  onChange(filters: WorkspaceFilters): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();

  return (
    <Popover
      open={anchorEl !== null}
      anchorEl={anchorEl}
      onClose={onClose}
      // Centred rather than anchored to an edge: MUI's origins are physical,
      // and centre is the one value that means the same in both directions.
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      slotProps={{ paper: { sx: { width: 320, padding: 4 } } }}
    >
      <Box
        component="section"
        aria-label={t('tickets:filters.title')}
        sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      >
        <Group label={t('tickets:filters.state')}>
          {ticketSystemStateSchema.options.map((state: TicketSystemState) => (
            <FilterChip
              key={state}
              label={t(`tickets:filters.states.${state}`)}
              on={filters.systemState.includes(state)}
              onToggle={() => {
                onChange({ ...filters, systemState: toggle(filters.systemState, state) });
              }}
            />
          ))}
        </Group>

        <Group label={t('tickets:filters.status')}>
          {statuses.map((status) => (
            <FilterChip
              key={status.id}
              label={statusName(status, locale)}
              on={filters.statusId.includes(status.id)}
              onToggle={() => {
                onChange({ ...filters, statusId: toggle(filters.statusId, status.id) });
              }}
            />
          ))}
        </Group>

        <Group label={t('tickets:filters.priority')}>
          {ticketPrioritySchema.options.map((priority) => (
            <FilterChip
              key={priority}
              label={t(`tickets:priority.${priority}`)}
              on={filters.priority.includes(priority)}
              onToggle={() => {
                onChange({ ...filters, priority: toggle(filters.priority, priority) });
              }}
            />
          ))}
        </Group>

        <Group label={t('tickets:filters.assignee')}>
          <FilterChip
            label={t('tickets:filters.me')}
            on={filters.assigneeId.includes('me')}
            onToggle={() => {
              onChange({ ...filters, assigneeId: toggle(filters.assigneeId, 'me') });
            }}
          />
          <FilterChip
            label={t('tickets:filters.unassigned')}
            on={filters.assigneeId.includes('unassigned')}
            onToggle={() => {
              onChange({ ...filters, assigneeId: toggle(filters.assigneeId, 'unassigned') });
            }}
          />
          {staff
            .filter((member) => member.userId !== viewerId)
            .map((member) => (
              <FilterChip
                key={member.userId}
                label={member.name}
                on={filters.assigneeId.includes(member.userId)}
                onToggle={() => {
                  onChange({ ...filters, assigneeId: toggle(filters.assigneeId, member.userId) });
                }}
              />
            ))}
        </Group>

        {departments.length === 0 ? null : (
          <Group label={t('tickets:filters.department')}>
            {departments.map((department) => (
              <FilterChip
                key={department.id}
                label={department.name}
                on={filters.departmentId.includes(department.id)}
                onToggle={() => {
                  onChange({
                    ...filters,
                    departmentId: toggle(filters.departmentId, department.id),
                  });
                }}
              />
            ))}
          </Group>
        )}

        {tags.length === 0 ? null : (
          <Group label={t('tickets:filters.tags')}>
            {tags.map((tag) => (
              <FilterChip
                key={tag.id}
                label={locale === 'ar' && tag.nameAr !== null ? tag.nameAr : tag.name}
                on={filters.tagIds.includes(tag.id)}
                onToggle={() => {
                  onChange({ ...filters, tagIds: toggle(filters.tagIds, tag.id) });
                }}
              />
            ))}
          </Group>
        )}

        <Group label={t('tickets:filters.sla')}>
          <FilterChip
            label={t('tickets:filters.overdue')}
            on={filters.overdue}
            onToggle={() => {
              onChange({ ...filters, overdue: !filters.overdue });
            }}
          />
        </Group>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          <Button
            variant="text"
            size="small"
            disabled={activeFilterCount(filters) === 0}
            onClick={() => {
              onChange(cleared(filters));
            }}
          >
            {t('tickets:filters.clear')}
          </Button>
        </Box>
      </Box>
    </Popover>
  );
}
