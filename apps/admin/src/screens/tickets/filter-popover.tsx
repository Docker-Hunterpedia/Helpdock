import type { Department, TicketPriority, TicketStatus } from '@helpdock/schemas';
import { ticketPrioritySchema } from '@helpdock/schemas';
import { Box, Button, Chip, Popover, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { statusName } from './format.js';

/**
 * The Filter button's popover: status, priority, assignee and department, each
 * a row of toggle chips.
 *
 * There is no Apply button. Every choice is written straight into the query
 * string and the list re-reads, which is the same rule the contact screens
 * follow — the URL is the state, so a filtered list is a link a colleague can
 * open and the back button steps through what somebody looked at.
 *
 * Assignee offers two values that are not people: "Assigned to me" and
 * "Unassigned". They are values of the same filter rather than switches of
 * their own, because `assigneeId` is one parameter and two switches would let
 * a person ask for both at once and get nothing.
 */

export interface TicketFilters {
  readonly statusId: readonly string[];
  readonly priority: readonly TicketPriority[];
  readonly assigneeId: readonly (string | 'unassigned')[];
  readonly departmentId: readonly string[];
}

export const EMPTY_FILTERS: TicketFilters = {
  statusId: [],
  priority: [],
  assigneeId: [],
  departmentId: [],
};

/** How many filters are on, for the count beside the button's label. */
export const activeFilterCount = (filters: TicketFilters): number =>
  filters.statusId.length +
  filters.priority.length +
  filters.assigneeId.length +
  filters.departmentId.length;

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
  staff,
  viewerId,
  onChange,
  onClose,
}: {
  readonly anchorEl: HTMLElement | null;
  readonly filters: TicketFilters;
  readonly statuses: readonly TicketStatus[];
  readonly departments: readonly Department[];
  readonly staff: readonly { readonly userId: string; readonly name: string }[];
  readonly viewerId: string;
  onChange(filters: TicketFilters): void;
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
            on={filters.assigneeId.includes(viewerId)}
            onToggle={() => {
              onChange({ ...filters, assigneeId: toggle(filters.assigneeId, viewerId) });
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

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          <Button
            variant="text"
            size="small"
            disabled={activeFilterCount(filters) === 0}
            onClick={() => {
              onChange(EMPTY_FILTERS);
            }}
          >
            {t('tickets:filters.clear')}
          </Button>
        </Box>
      </Box>
    </Popover>
  );
}
