import { Box, IconButton, Typography } from '@mui/material';
import { Info, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { useRealtime } from '../realtime/realtime-provider.tsx';

/** Long enough to read a sentence and decide, as a Toast with an action is (DESIGN §6.4). */
export const IDLE_RETURN_NOTICE_MS = 10_000;

/**
 * M14-18, `Admin/Ticketing-Assignment-Idle` "on return": the neutral notice a
 * person sees once when their own activity ends an idle away.
 *
 * It is a polite live region that is mounted all the time and only filled
 * when there is something to say, so a screen reader announces the sentence
 * when it appears, and it takes no focus: a person who came back by typing
 * keeps typing in the same field. The region has `aria-live` and no `status`
 * role, as the SequenceChip's does, so it never competes with the toasts for a
 * `status` locator while it is empty. It goes by itself after ten seconds,
 * pausing while the pointer or focus is on it (WCAG 2.2.1), or at the close
 * button.
 */
export function IdleReturnNotice(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { idleReturned, dismissIdleReturn } = useRealtime();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!idleReturned || paused) {
      return undefined;
    }

    const timer = setTimeout(dismissIdleReturn, IDLE_RETURN_NOTICE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [idleReturned, paused, dismissIdleReturn]);

  return (
    <Box
      aria-live="polite"
      aria-atomic="true"
      sx={{
        position: 'fixed',
        insetBlockStart: 16,
        insetInline: 0,
        marginInline: 'auto',
        inlineSize: 'min(520px, calc(100% - 32px))',
        zIndex: 'snackbar',
        pointerEvents: idleReturned ? 'auto' : 'none',
      }}
    >
      {idleReturned ? (
        <Box
          onMouseEnter={() => {
            setPaused(true);
          }}
          onMouseLeave={() => {
            setPaused(false);
          }}
          onFocus={() => {
            setPaused(true);
          }}
          onBlur={() => {
            setPaused(false);
          }}
          sx={{
            display: 'flex',
            gap: 2,
            alignItems: 'flex-start',
            padding: 3,
            borderRadius: '6px',
            backgroundColor: tokens['bg.muted'],
            color: tokens['text.secondary'],
            border: `1px solid ${tokens['border.default']}`,
          }}
        >
          <Info size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
          <Typography variant="body2" sx={{ color: 'inherit', flex: 1 }}>
            {t('admin:presence.idleReturned')}
          </Typography>
          <IconButton
            size="small"
            aria-label={t('admin:presence.idleReturnedDismiss')}
            onClick={dismissIdleReturn}
            sx={{ marginBlock: '-4px', marginInlineEnd: '-4px', color: 'inherit' }}
          >
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>
      ) : null}
    </Box>
  );
}
