import type { TimeEntry, TimeEntryList } from '@helpdock/schemas';
import { Box, Button, IconButton, Typography } from '@mui/material';
import { Pause, Play, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { messageTime } from './format.js';
import { clockOf, durationOf } from './time-format.js';
import type { TicketTimer } from './use-ticket-timer.js';

/**
 * The Time card of the details panel (`AdminTicketDialogs`, panel 8; M1-12):
 * the ticket's total, the timer, the entries newest first, and "Add time
 * manually".
 *
 * **Log** turns what the timer counted into an entry of its own; sending a
 * reply does the same with the reply attached (`ticket-view.tsx`). An entry can
 * be deleted by whoever logged it, and by a Team Leader or an Admin — the api
 * decides, and the button is drawn only where it would be allowed.
 *
 * A Viewer reads the card and has none of its controls: they cannot write to a
 * ticket, and a timer they could start but never log would be a lie.
 */
export interface TimeCardProps {
  readonly entries: TimeEntryList | undefined;
  readonly failed: boolean;
  readonly timer: TicketTimer;
  readonly viewerId: string;
  readonly canWrite: boolean;
  readonly canDeleteAny: boolean;
  readonly busy: boolean;
  readonly now: number;
  onLogTimer(): void;
  onAddManually(): void;
  onDelete(entry: TimeEntry): void;
}

export function TimeCard({
  entries,
  failed,
  timer,
  viewerId,
  canWrite,
  canDeleteAny,
  busy,
  now,
  onLogTimer,
  onAddManually,
  onDelete,
}: TimeCardProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const headingId = useId();
  const clock = clockOf(timer.seconds);
  const duration = durationOf(timer.seconds);

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        padding: 4,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography id={headingId} variant="bodyStrong" component="h2" sx={{ flex: 1 }}>
          {t('tickets:time.heading')}
        </Typography>
        {entries === undefined ? null : (
          <Typography variant="mono" sx={{ fontSize: 13 }}>
            <bdi>{t('tickets:time.total', { duration: durationOf(entries.totalSeconds) })}</bdi>
          </Typography>
        )}
      </Box>

      {canWrite ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            paddingBlock: 2,
            paddingInline: 3,
            borderRadius: '8px',
            backgroundColor: tokens['action.primary.tint'],
          }}
        >
          <Typography
            role="timer"
            aria-label={t(
              timer.running ? 'tickets:time.timerRunning' : 'tickets:time.timerPaused',
              {
                duration,
              },
            )}
            variant="mono"
            sx={{ flex: 1, fontSize: 18, lineHeight: '24px', fontWeight: 500 }}
          >
            <bdi>{clock}</bdi>
          </Typography>
          <IconButton
            size="small"
            aria-label={t(timer.running ? 'tickets:time.pause' : 'tickets:time.start')}
            onClick={timer.running ? timer.pause : timer.start}
            sx={{
              border: `1px solid ${tokens['border.strong']}`,
              backgroundColor: tokens['bg.surface'],
            }}
          >
            {timer.running ? (
              <Pause size={14} aria-hidden="true" />
            ) : (
              <Play size={14} aria-hidden="true" />
            )}
          </IconButton>
          <Button
            variant="contained"
            size="small"
            disabled={busy || timer.seconds < 1}
            onClick={onLogTimer}
          >
            {t('tickets:time.log')}
          </Button>
        </Box>
      ) : null}

      {failed ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('tickets:time.loadFailed')}
        </Typography>
      ) : entries === undefined ? null : entries.entries.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('tickets:time.empty')}
        </Typography>
      ) : (
        <Box component="ul" sx={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {entries.entries.map((entry) => (
            <Box
              component="li"
              key={entry.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                paddingBlock: 2,
                borderBlockStart: `1px solid ${tokens['border.default']}`,
              }}
            >
              <Typography variant="mono" sx={{ inlineSize: 56, flexShrink: 0, fontSize: 13 }}>
                <bdi>{durationOf(entry.seconds)}</bdi>
              </Typography>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0, color: 'text.secondary' }}>
                {entry.userName}
                {' · '}
                {entry.note ??
                  t(entry.messageId === null ? 'tickets:time.manual' : 'tickets:time.withReply')}
                {' · '}
                <bdi>{messageTime(entry.createdAt, locale, now)}</bdi>
              </Typography>
              {canWrite && (canDeleteAny || entry.userId === viewerId) ? (
                <IconButton
                  size="small"
                  aria-label={t('tickets:time.delete')}
                  disabled={busy}
                  onClick={() => {
                    onDelete(entry);
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </IconButton>
              ) : null}
            </Box>
          ))}
        </Box>
      )}

      {canWrite ? (
        <Button
          variant="outlined"
          size="small"
          startIcon={<Plus size={14} aria-hidden="true" />}
          onClick={onAddManually}
          disabled={busy}
          sx={{ alignSelf: 'flex-start' }}
        >
          {t('tickets:time.addManually')}
        </Button>
      ) : null}
    </Box>
  );
}
