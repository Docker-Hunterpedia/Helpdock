import type { TimeEntryCreateRequest } from '@helpdock/schemas';
import { TIME_ENTRY_NOTE_MAX } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import { X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { durationOf, secondsFrom } from './time-format.js';

/**
 * Log time (`AdminTicketDialogs`, panel 6; M1-12): hours, minutes and an
 * optional staff-only note. The primary button names what it will log — "Log
 * 30m" — so the person reads the total before committing it, and it stays
 * disabled while the fields break the dialog's own rule.
 */
export function LogTimeDialog({
  open,
  reference,
  viewerName,
  busy,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly reference: string;
  readonly viewerName: string;
  readonly busy: boolean;
  onClose(): void;
  onSubmit(request: TimeEntryCreateRequest): void;
}): ReactNode {
  const t = useT();
  const titleId = useId();
  const [hours, setHours] = useState('0');
  const [minutes, setMinutes] = useState('30');
  const [note, setNote] = useState('');

  // Every opening starts from the drawn defaults.
  useEffect(() => {
    if (open) {
      setHours('0');
      setMinutes('30');
      setNote('');
    }
  }, [open]);

  const seconds = secondsFrom(Number(hours), Number(minutes));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (seconds === null) {
      return;
    }

    const trimmed = note.trim();
    onSubmit({ seconds, ...(trimmed === '' ? {} : { note: trimmed }) });
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
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 3, paddingInlineEnd: 3 }}>
          <Box sx={{ flex: 1 }}>
            <DialogTitle id={titleId} sx={{ fontSize: 18, fontWeight: 600, paddingBlockEnd: 1 }}>
              {t('tickets:logTime.title')}
            </DialogTitle>
            <Typography variant="body2" sx={{ color: 'text.secondary', paddingInline: 6 }}>
              {t('tickets:logTime.caption', { reference, name: viewerName })}
            </Typography>
          </Box>
          <IconButton
            aria-label={t('tickets:logTime.close')}
            onClick={onClose}
            sx={{ marginBlockStart: 4 }}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
            <TextField
              type="number"
              size="small"
              label={t('tickets:logTime.hours')}
              value={hours}
              onChange={(event) => {
                setHours(event.target.value);
              }}
              slotProps={{ htmlInput: { min: 0, max: 24, step: 1 } }}
            />
            <TextField
              type="number"
              size="small"
              label={t('tickets:logTime.minutes')}
              value={minutes}
              onChange={(event) => {
                setMinutes(event.target.value);
              }}
              slotProps={{ htmlInput: { min: 0, max: 59, step: 1 } }}
            />
          </Box>
          {seconds === null ? (
            <Typography variant="caption" role="alert" sx={{ color: 'error.main' }}>
              {t('tickets:logTime.invalid')}
            </Typography>
          ) : null}
          <TextField
            size="small"
            label={t('tickets:logTime.note')}
            value={note}
            helperText={t('tickets:logTime.noteHint')}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            slotProps={{ htmlInput: { maxLength: TIME_ENTRY_NOTE_MAX } }}
          />
        </DialogContent>

        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('tickets:logTime.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy || seconds === null}>
            {seconds === null
              ? t('tickets:logTime.submitEmpty')
              : t('tickets:logTime.submit', { duration: durationOf(seconds) })}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
