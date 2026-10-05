import { type TicketChannel, ticketChannelSchema } from '@helpdock/schemas';
import { Box, Button, MenuItem, Popover, TextField, Typography } from '@mui/material';
import { CalendarDays } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { formatDay, formatDayMonth } from '../../ui/format.js';
import {
  type DateRange,
  isValidRange,
  presetRange,
  RANGE_PRESETS,
  rangeDays,
} from './report-range.js';

/**
 * The filter row of `Admin/Reports` (M8-04): date range, department and
 * channel, each sent to the api. The artboard's Agent filter is not drawn:
 * the report routes take no agent, and Agent workload already lists everyone.
 */

export interface ReportFilters {
  readonly range: DateRange;
  readonly departmentId: string | undefined;
  readonly channel: TicketChannel | undefined;
}

const ALL = 'all';

/** "5 Sep – 4 Oct 2026 · 30 days", in the reader's language with Latin digits. */
export function useRangeLabel(): (range: DateRange) => string {
  const t = useT();
  const { locale } = usePreferences();

  return (range) =>
    t('reports:filters.rangeLabel', {
      from: formatDayMonth(range.from, locale, 'UTC'),
      to: formatDay(range.to, locale, 'UTC'),
      count: rangeDays(range),
    });
}

export function ReportFilterBar({
  filters,
  departments,
  onChange,
}: {
  readonly filters: ReportFilters;
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  onChange(filters: ReportFilters): void;
}): ReactNode {
  const t = useT();
  const rangeLabel = useRangeLabel();
  const rangeId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-end',
        gap: 3,
      }}
    >
      <Box sx={{ display: 'grid', gap: 1 }}>
        <Typography id={rangeId} component="span" sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('reports:filters.range')}
        </Typography>
        <Button
          variant="outlined"
          aria-describedby={rangeId}
          aria-haspopup="dialog"
          aria-expanded={anchor !== null}
          startIcon={<CalendarDays size={16} aria-hidden="true" />}
          onClick={(event) => {
            setAnchor(event.currentTarget);
          }}
          sx={{ justifyContent: 'flex-start' }}
        >
          {rangeLabel(filters.range)}
        </Button>
        <RangePopover
          anchor={anchor}
          range={filters.range}
          onClose={() => {
            setAnchor(null);
          }}
          onApply={(range) => {
            setAnchor(null);
            onChange({ ...filters, range });
          }}
        />
      </Box>

      <TextField
        select
        size="small"
        label={t('reports:filters.department')}
        value={filters.departmentId ?? ALL}
        onChange={(event) => {
          const value = event.target.value;
          onChange({ ...filters, departmentId: value === ALL ? undefined : value });
        }}
        sx={{ minWidth: 200 }}
      >
        <MenuItem value={ALL}>{t('reports:filters.allDepartments')}</MenuItem>
        {departments.map((department) => (
          <MenuItem key={department.id} value={department.id}>
            {department.name}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        select
        size="small"
        label={t('reports:filters.channel')}
        value={filters.channel ?? ALL}
        onChange={(event) => {
          const parsed = ticketChannelSchema.safeParse(event.target.value);
          onChange({ ...filters, channel: parsed.success ? parsed.data : undefined });
        }}
        sx={{ minWidth: 180 }}
      >
        <MenuItem value={ALL}>{t('reports:filters.allChannels')}</MenuItem>
        {ticketChannelSchema.options.map((channel) => (
          <MenuItem key={channel} value={channel}>
            {t(`tickets:channel.${channel}`)}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

function RangePopover({
  anchor,
  range,
  onClose,
  onApply,
}: {
  readonly anchor: HTMLElement | null;
  readonly range: DateRange;
  onClose(): void;
  onApply(range: DateRange): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  // MUI anchors physically; the popover opens under the button's inline start.
  const start = locale === 'ar' ? 'right' : 'left';
  const headingId = useId();
  const [draft, setDraft] = useState<DateRange>(range);
  const valid = isValidRange(draft);

  return (
    <Popover
      open={anchor !== null}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: start }}
      transformOrigin={{ vertical: 'top', horizontal: start }}
      slotProps={{
        transition: {
          onEnter: () => {
            setDraft(range);
          },
        },
        paper: { role: 'dialog', 'aria-labelledby': headingId, sx: { padding: 4 } },
      }}
    >
      <Box sx={{ display: 'grid', gap: 3, width: 280 }}>
        <Typography id={headingId} variant="h3" component="h2">
          {t('reports:filters.range')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {RANGE_PRESETS.map((days) => (
            <Button
              key={days}
              size="small"
              variant="outlined"
              onClick={() => {
                onApply(presetRange(days));
              }}
            >
              {t('reports:filters.lastDays', { count: days })}
            </Button>
          ))}
        </Box>
        <TextField
          type="date"
          size="small"
          label={t('reports:filters.from')}
          value={draft.from}
          slotProps={{ inputLabel: { shrink: true } }}
          onChange={(event) => {
            setDraft({ ...draft, from: event.target.value });
          }}
        />
        <TextField
          type="date"
          size="small"
          label={t('reports:filters.to')}
          value={draft.to}
          slotProps={{ inputLabel: { shrink: true } }}
          error={!valid}
          helperText={valid ? undefined : t('reports:filters.invalidRange')}
          onChange={(event) => {
            setDraft({ ...draft, to: event.target.value });
          }}
        />
        <Button
          variant="contained"
          disabled={!valid}
          onClick={() => {
            onApply(draft);
          }}
        >
          {t('reports:filters.apply')}
        </Button>
      </Box>
    </Popover>
  );
}
