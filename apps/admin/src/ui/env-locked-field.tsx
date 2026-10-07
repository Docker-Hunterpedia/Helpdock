import { Box, TextField, Typography } from '@mui/material';
import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * DESIGN §6.1 EnvLockedField: a setting `.env` overrides (M7-10,
 * `Admin/AI-Providers`). A read-only input on `bg.canvas` with a lock in its
 * label, and a hint naming the variable, because the only way to change it is
 * there.
 */
export function EnvLockedField({
  id,
  label,
  value,
  variable,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  /** The environment variable that pins it, e.g. `HD_TRANSCRIPTION_ENDPOINT`. */
  readonly variable: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const hintId = `${id}-hint`;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Typography
        component="label"
        htmlFor={id}
        sx={{
          fontSize: 13,
          fontWeight: 500,
          lineHeight: '20px',
          marginBlockEnd: '6px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Lock size={14} aria-hidden="true" />
        {label}
      </Typography>
      <TextField
        id={id}
        size="small"
        value={value}
        slotProps={{
          htmlInput: { readOnly: true, dir: 'ltr', 'aria-describedby': hintId },
          input: {
            sx: {
              backgroundColor: tokens['bg.canvas'],
              color: tokens['text.secondary'],
              fontFamily: 'var(--hd-font-mono, monospace)',
              fontSize: 13,
            },
          },
        }}
      />
      <Typography
        id={hintId}
        variant="caption"
        sx={{ marginBlockStart: '6px', color: 'text.secondary' }}
      >
        {t('aiSettings:env.hintBefore')}{' '}
        <Box
          component="code"
          dir="ltr"
          sx={{ backgroundColor: tokens['bg.muted'], paddingInline: 1, borderRadius: '4px' }}
        >
          {variable}
        </Box>{' '}
        {t('aiSettings:env.hintAfter')}
      </Typography>
    </Box>
  );
}

/** The "Set by environment" chip beside a card heading or in a table row. */
export function EnvChip(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        height: 20,
        paddingInline: 2,
        borderRadius: '6px',
        backgroundColor: tokens['status.warning.tint'],
        color: tokens['status.warning.text'],
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <Lock size={14} aria-hidden="true" />
      {t('aiSettings:env.chip')}
    </Box>
  );
}
