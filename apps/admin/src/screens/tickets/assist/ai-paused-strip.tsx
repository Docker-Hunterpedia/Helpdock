import { Box, Button, Typography } from '@mui/material';
import { CirclePause, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 AIPausedStrip: between the thread and the composer while
 * `ai_paused_until` holds a conversation (DOMAIN-RULES §9). Display only: the
 * pause and "Return to assistant" are auto-reply's (M7-06), which passes
 * `onReturn` when it lands; without it the button is not drawn.
 */
export function AIPausedStrip({
  since,
  onReturn,
}: {
  /** When the assistant handed off, as the thread writes a time. */
  readonly since: string;
  readonly onReturn?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      role="status"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        padding: '8px 12px',
        borderRadius: '6px',
        backgroundColor: tokens['bg.muted'],
        border: `1px solid ${tokens['border.default']}`,
        color: 'text.secondary',
        fontSize: 13,
      }}
    >
      <CirclePause size={16} aria-hidden="true" />
      <Typography component="span" sx={{ fontSize: 13 }}>
        <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
          {t('tickets:assist.paused.label')}
        </Box>
        {' · '}
        {t('tickets:assist.paused.since')}{' '}
        <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
          {since}
        </Typography>
      </Typography>
      {onReturn === undefined ? null : (
        <Button
          size="small"
          variant="outlined"
          startIcon={<RotateCcw size={14} aria-hidden="true" />}
          onClick={onReturn}
          sx={{ marginInlineStart: 'auto' }}
        >
          {t('tickets:assist.paused.return')}
        </Button>
      )}
    </Box>
  );
}
