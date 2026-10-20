import { Box, Button } from '@mui/material';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 SnoozedStrip (M14-02, `Admin/Ticket-Snooze`): above the thread
 * while a ticket is Snoozed. It names who snoozed it and until when, says what
 * wakes it early, and offers *Wake now* at the inline end. One `role="status"`,
 * so it is announced when it appears and keeps the on-hold (warning) hue the
 * Snoozed status is mapped to.
 */
export function SnoozedStrip({
  by,
  until,
  canWake,
  busy,
  onWake,
}: {
  /** Who snoozed it; null when they have left or an api key did. */
  readonly by: string | null;
  /** The wake time, already formatted for the reader. */
  readonly until: string;
  readonly canWake: boolean;
  readonly busy: boolean;
  onWake(): void;
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
        padding: '10px 14px',
        borderRadius: '6px',
        backgroundColor: tokens['status.warning.tint'],
        color: tokens['status.warning.text'],
        fontSize: 13,
        lineHeight: '20px',
      }}
    >
      <Clock size={16} aria-hidden="true" />
      <Box component="span" sx={{ flex: 1, minWidth: 0 }}>
        {by === null
          ? t('tickets:snooze.strip.until', { time: until })
          : t('tickets:snooze.strip.by', { name: by, time: until })}{' '}
        {t('tickets:snooze.strip.wakes')}
      </Box>
      {canWake ? (
        <Button size="small" variant="outlined" disabled={busy} onClick={onWake}>
          {t('tickets:snooze.strip.wakeNow')}
        </Button>
      ) : null}
    </Box>
  );
}
