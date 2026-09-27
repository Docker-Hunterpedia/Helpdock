import type { WeeklyHours } from '@helpdock/schemas';
import { Box, IconButton, Switch, TextField, Typography } from '@mui/material';
import { Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import {
  addRange,
  firstInvalidDay,
  rangeBackwards,
  removeRange,
  setDayOpen,
  setRange,
  WEEKDAY_KEYS,
} from './hours-draft.js';

/**
 * DESIGN §6.1 WeekHoursEditor (M3-01): one row per day, Sunday first — the
 * day, a switch for open or closed, and its ranges as two time inputs with a
 * remove and an add button. A day can hold several ranges ("09:00–12:00,
 * 13:00–17:00"). A range that ends before it starts is marked on its row and
 * named under it; the tab refuses to save until it is fixed.
 */
export function WeekEditor({
  weekly,
  onChange,
  showStateLabel = true,
  disabled = false,
}: {
  readonly weekly: WeeklyHours;
  onChange(next: WeeklyHours): void;
  /** The brand's week names each day's state beside the switch; an override's does not. */
  readonly showStateLabel?: boolean;
  readonly disabled?: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const invalid = firstInvalidDay(weekly);

  return (
    <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {WEEKDAY_KEYS.map((key, day) => {
        const ranges = weekly[day] ?? [];
        const dayName = t(`ticketing:businessHours.days.${key}`);
        const open = ranges.length > 0;

        return (
          <Box
            component="li"
            key={key}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '104px 96px minmax(0, 1fr)' },
              alignItems: 'start',
              gap: 2,
              paddingBlock: 2,
              paddingInline: 4,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
            }}
          >
            <Typography variant="bodyStrong" component="span" sx={{ paddingBlockStart: 1.5 }}>
              {dayName}
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minBlockSize: 36 }}>
              <Switch
                size="small"
                checked={open}
                disabled={disabled}
                slotProps={{
                  input: {
                    role: 'switch',
                    'aria-label': t('ticketing:businessHours.weekly.dayOpen', { day: dayName }),
                  },
                }}
                onChange={(event) => {
                  onChange(setDayOpen(weekly, day, event.target.checked));
                }}
              />
              {showStateLabel ? (
                <Typography variant="body2" component="span">
                  {open
                    ? t('ticketing:businessHours.weekly.open')
                    : t('ticketing:businessHours.weekly.closed')}
                </Typography>
              ) : null}
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {open ? (
                ranges.map((range, index) => {
                  const backwards = rangeBackwards(range);
                  const label = `${range.start}–${range.end}`;
                  const last = index === ranges.length - 1;

                  return (
                    <Box
                      // A range has no id of its own; its place in the day is its identity.
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                      key={index}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
                    >
                      <TimeInput
                        value={range.start}
                        label={t('ticketing:businessHours.weekly.opens', { day: dayName })}
                        invalid={backwards}
                        disabled={disabled}
                        onChange={(start) => {
                          onChange(setRange(weekly, day, index, { ...range, start }));
                        }}
                      />
                      <Box component="span" aria-hidden="true" sx={{ color: 'text.secondary' }}>
                        –
                      </Box>
                      <TimeInput
                        value={range.end === '24:00' ? '23:59' : range.end}
                        label={t('ticketing:businessHours.weekly.closes', { day: dayName })}
                        invalid={backwards}
                        disabled={disabled}
                        onChange={(end) => {
                          onChange(setRange(weekly, day, index, { ...range, end }));
                        }}
                      />
                      <IconButton
                        size="small"
                        disabled={disabled}
                        aria-label={t('ticketing:businessHours.weekly.remove', {
                          day: dayName,
                          range: label,
                        })}
                        onClick={() => {
                          onChange(removeRange(weekly, day, index));
                        }}
                      >
                        <X size={16} aria-hidden="true" />
                      </IconButton>
                      {last ? (
                        <IconButton
                          size="small"
                          disabled={disabled || ranges.length >= 4}
                          aria-label={t('ticketing:businessHours.weekly.add', { day: dayName })}
                          onClick={() => {
                            onChange(addRange(weekly, day));
                          }}
                          sx={{ color: 'primary.main' }}
                        >
                          <Plus size={16} aria-hidden="true" />
                        </IconButton>
                      ) : null}
                    </Box>
                  );
                })
              ) : (
                <Typography
                  variant="body2"
                  component="span"
                  sx={{ color: 'text.secondary', paddingBlockStart: 1.5 }}
                >
                  {t('ticketing:businessHours.weekly.closedAllDay')}
                </Typography>
              )}
              {invalid === day ? (
                <Typography variant="caption" role="alert" sx={{ color: tokens['status.danger'] }}>
                  {ranges.some(rangeBackwards)
                    ? t('ticketing:businessHours.weekly.backwards')
                    : t('ticketing:businessHours.weekly.overlap')}
                </Typography>
              ) : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function TimeInput({
  value,
  label,
  invalid,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly label: string;
  readonly invalid: boolean;
  readonly disabled: boolean;
  onChange(value: string): void;
}): ReactNode {
  return (
    <TextField
      type="time"
      size="small"
      value={value}
      error={invalid}
      disabled={disabled}
      slotProps={{
        htmlInput: { 'aria-label': label, 'aria-invalid': invalid, step: 300 },
      }}
      onChange={(event) => {
        if (event.target.value !== '') {
          onChange(event.target.value);
        }
      }}
      sx={{ inlineSize: 128, '& input': { fontFamily: 'var(--hd-font-mono, monospace)' } }}
    />
  );
}
