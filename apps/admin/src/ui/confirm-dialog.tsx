import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';

/**
 * DESIGN §6.4 Dialog, in its confirmation size: 480 px, an h3 title, one
 * sentence, and two actions end-aligned — ghost Cancel, then the primary, or
 * solid danger when the thing it does cannot be undone in one click.
 *
 * Every destructive action on the staff screen goes through it, so "are you
 * sure?" is asked the same way each time and is worded in the catalog rather
 * than at the call site.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  confirmDisabled = false,
  children,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  /** Draws the primary in danger and keeps `Esc` from closing mid-flight. */
  readonly destructive?: boolean;
  readonly busy?: boolean;
  /**
   * Holds the primary back until the confirmation is complete — erasing a
   * contact waits for its name to be typed (M1-14).
   */
  readonly confirmDisabled?: boolean;
  /**
   * A field the confirmation itself needs, under the sentence. Turning the
   * second factor off asks for a live code here, because the dialog *is* the
   * credential check rather than a courtesy.
   */
  readonly children?: ReactNode;
  onConfirm(): void;
  onClose(): void;
}): ReactNode {
  const t = useT();

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
    >
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>{title}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {body}
        </Typography>
        {children}
      </DialogContent>
      <DialogActions sx={{ padding: 4, gap: 2 }}>
        <Button variant="text" onClick={onClose} disabled={busy}>
          {t('common:actions.cancel')}
        </Button>
        <Button
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
