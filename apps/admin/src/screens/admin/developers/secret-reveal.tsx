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
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.4 SecretReveal: the one time a generated secret is shown — an API
 * key after Create (`Admin/Developers-ApiKeys` panel 2), a webhook signing
 * secret after Add or Rotate (`Admin/Developers-Webhooks` panel 2).
 *
 * A warning notice says why it is shown once, then the secret as a read-only
 * mono input with Copy beside it and a status line once it is copied; the
 * summary box under it is the caller's. "Done" is the only way out: the
 * Dialog has no `onClose`, so neither Esc nor a backdrop click dismisses it,
 * because after it there is no way back to the value.
 */
export function SecretReveal({
  open,
  title,
  warningStrong,
  warning,
  label,
  secret,
  children,
  onDone,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly warningStrong: string;
  readonly warning: string;
  /** What the input is labelled: the key's name, or "Signing secret". */
  readonly label: string;
  readonly secret: string;
  /** The summary box: what the secret can do, or the test event. */
  readonly children?: ReactNode;
  onDone(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const titleId = useId();
  const inputId = useId();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copySecret = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };

  return (
    <Dialog
      open={open}
      aria-labelledby={titleId}
      maxWidth="xs"
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 480, borderRadius: '10px' } } }}
    >
      <DialogTitle id={titleId} sx={{ fontSize: 16, fontWeight: 600 }}>
        {title}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Box
          role="note"
          sx={{
            display: 'flex',
            gap: 2,
            alignItems: 'flex-start',
            padding: 3,
            borderRadius: '6px',
            backgroundColor: tokens['status.warning.tint'],
            border: `1px solid ${tokens['status.warning']}`,
            color: tokens['status.warning.text'],
          }}
        >
          <TriangleAlert
            size={16}
            aria-hidden="true"
            style={{ flexShrink: 0, marginBlockStart: 2 }}
          />
          <Typography variant="body2" sx={{ color: 'inherit' }}>
            <strong>{warningStrong}</strong> {warning}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <Typography
            component="label"
            htmlFor={inputId}
            sx={{ fontSize: 13, fontWeight: 500, lineHeight: '20px' }}
          >
            {label}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              id={inputId}
              size="small"
              value={secret}
              slotProps={{
                htmlInput: {
                  readOnly: true,
                  dir: 'ltr',
                  spellCheck: false,
                  style: { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 },
                  onFocus: (event: { currentTarget: HTMLInputElement }) => {
                    event.currentTarget.select();
                  },
                },
              }}
              sx={{ flexGrow: 1, minWidth: 0 }}
            />
            <Button
              variant="outlined"
              color="inherit"
              startIcon={<Copy size={16} aria-hidden="true" />}
              onClick={() => {
                void copySecret();
              }}
              sx={{ flexShrink: 0 }}
            >
              {t('developers:copy')}
            </Button>
          </Box>
          <Box role="status" sx={{ minBlockSize: 18 }}>
            {copy === 'idle' ? null : (
              <Typography
                variant="caption"
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 1,
                  color: tokens[copy === 'copied' ? 'status.success.text' : 'status.danger.text'],
                }}
              >
                {copy === 'copied' ? <Check size={14} aria-hidden="true" /> : null}
                {t(copy === 'copied' ? 'developers:copied' : 'developers:copyFailed')}
              </Typography>
            )}
          </Box>
        </Box>

        {children === undefined ? null : (
          <Box
            sx={{
              padding: 3,
              borderRadius: '6px',
              backgroundColor: tokens['bg.canvas'],
              border: `1px solid ${tokens['border.default']}`,
            }}
          >
            {children}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ padding: 4 }}>
        <Button
          variant="contained"
          onClick={() => {
            setCopy('idle');
            onDone();
          }}
        >
          {t('developers:done')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
