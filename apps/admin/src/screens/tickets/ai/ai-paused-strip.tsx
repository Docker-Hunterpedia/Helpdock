import { Box, Button, Typography } from '@mui/material';
import { PauseCircle, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 AIPausedStrip (M7-06, `Admin/Ticket-AI`): between the thread
 * and the Composer while `ai_paused_until` holds, "Assistant paused · handed
 * off at 09:18" and "Return to assistant" at the inline end. A `status`, so
 * it is announced when it appears without taking focus.
 */
export function AIPausedStrip({
  time,
  canResume,
  busy,
  onResume,
}: {
  /** When it was handed off, already formatted for the reader. */
  readonly time: string;
  readonly canResume: boolean;
  readonly busy: boolean;
  onResume(): void;
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
        lineHeight: '20px',
      }}
    >
      <PauseCircle size={16} aria-hidden="true" />
      <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
        <Box component="strong" sx={{ fontWeight: 600, color: 'text.primary' }}>
          {t('tickets:autoReply.paused')}
        </Box>
        {' · '}
        {t('tickets:autoReply.pausedAt')}{' '}
        <Typography variant="mono" component="span" sx={{ fontSize: 13 }}>
          <bdi>{time}</bdi>
        </Typography>
      </Box>
      {canResume ? (
        <Button
          size="small"
          variant="outlined"
          startIcon={<RotateCcw size={16} aria-hidden="true" />}
          disabled={busy}
          onClick={onResume}
        >
          {t('tickets:autoReply.resume')}
        </Button>
      ) : null}
    </Box>
  );
}
