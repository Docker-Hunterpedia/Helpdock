import { SNOOZE_MAX_MS, SNOOZE_MIN_MS } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { isolate, wakeTime } from '../format.js';

/**
 * "Pick a date and time…" (M14-02, `Admin/Ticket-Snooze` panel 2): a native
 * `datetime-local` input, which a screen reader and a phone already know how
 * to drive, bounded to what the api accepts — 5 minutes to 90 days ahead —
 * beside a read-only time zone field. When the department works in another zone a
 * caption gives both times.
 *
 * The bounds are checked here for the message and again by the api for the
 * rule: a clock that moved while the dialog was open is the api's refusal.
 */

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DDTHH:mm` in the reader's local time, which is what the input holds. */
const localInput = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;

export type PickProblem = 'invalid' | 'tooSoon' | 'tooFar';

/** Why a typed value cannot be a snooze, or `null` when it can. */
export const pickProblem = (value: string, now: number): PickProblem | null => {
  const at = new Date(value).getTime();
  if (value === '' || Number.isNaN(at)) {
    return 'invalid';
  }
  if (at - now < SNOOZE_MIN_MS) {
    return 'tooSoon';
  }

  return at - now > SNOOZE_MAX_MS ? 'tooFar' : null;
};

export function SnoozePickerDialog({
  open,
  agentZone,
  departmentName,
  departmentZone,
  busy,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly agentZone: string;
  readonly departmentName: string;
  /** The department's zone when it is not the reader's; null hides the caption. */
  readonly departmentZone: string | null;
  readonly busy: boolean;
  onClose(): void;
  onSubmit(until: string): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const titleId = useId();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  // Every opening starts at the next whole hour, an hour or more ahead.
  useEffect(() => {
    if (open) {
      const start = new Date(Date.now() + 2 * 3_600_000);
      start.setMinutes(0, 0, 0);
      setValue(localInput(start));
      setTouched(false);
    }
  }, [open]);

  const now = Date.now();
  const problem = pickProblem(value, now);
  const iso = problem === null ? new Date(value).toISOString() : null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (iso !== null) {
      onSubmit(iso);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      aria-labelledby={titleId}
      slotProps={{ paper: { sx: { maxWidth: 400 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id={titleId} variant="h3">
          {t('tickets:snooze.dialog.title')}
        </DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: 3 }}>
          <TextField
            type="datetime-local"
            label={t('tickets:snooze.dialog.when')}
            value={value}
            size="small"
            fullWidth
            onChange={(event) => {
              setValue(event.target.value);
              setTouched(true);
            }}
            slotProps={{
              inputLabel: { shrink: true },
              formHelperText: { role: 'alert' },
              htmlInput: {
                min: localInput(new Date(now + SNOOZE_MIN_MS)),
                max: localInput(new Date(now + SNOOZE_MAX_MS)),
                dir: 'ltr',
              },
            }}
            error={touched && problem !== null}
            helperText={
              touched && problem !== null ? t(`tickets:snooze.dialog.${problem}`) : undefined
            }
          />
          <TextField
            label={t('tickets:snooze.dialog.timeZone')}
            value={agentZone}
            size="small"
            fullWidth
            slotProps={{
              inputLabel: { shrink: true },
              htmlInput: { readOnly: true, dir: 'ltr' },
            }}
          />
          {departmentZone !== null && iso !== null ? (
            <Typography variant="caption" color="text.secondary">
              {t('tickets:snooze.dialog.bothZones', {
                yours: isolate(wakeTime(iso, locale, now)),
                theirs: isolate(wakeTime(iso, locale, now, departmentZone)),
                department: departmentName,
                zone: isolate(departmentZone),
              })}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ padding: 5, paddingBlockStart: 2 }}>
          <Button variant="outlined" onClick={onClose}>
            {t('tickets:snooze.dialog.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || problem !== null}>
            {t('tickets:snooze.dialog.confirm')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
