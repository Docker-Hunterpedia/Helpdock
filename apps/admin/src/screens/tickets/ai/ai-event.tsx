import type { TicketMessage, TicketMessageAi } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { PauseCircle, RotateCcw, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';

/**
 * What paused or resumed the assistant, as the thread's System event with an
 * icon and the time in mono (DESIGN §6.3 AIPausedStrip, `Admin/Ticket-AI`
 * boards 1 and 7). Worded here in the reader's language from `ai_meta`; the
 * body the api stored is the brand's language, for everybody else.
 */
export function AiEventText({
  message,
  ai,
  staffName,
  time,
}: {
  readonly message: TicketMessage;
  readonly ai: TicketMessageAi;
  /** The staff member who caused it, when one did. */
  readonly staffName: string | null;
  readonly time: string;
}): ReactNode {
  const t = useT();
  // The key is built from the reason, which the typed `t` cannot check; every
  // reason of `aiPauseReasonSchema` has its sentence in both catalogs.
  const translate = t as unknown as (key: string, values?: Record<string, unknown>) => string;
  const name = staffName ?? t('tickets:autoReply.event.someone');
  const handedOff = ai.reason === 'low_confidence' || ai.reason === 'invalid_citation';
  const sentence =
    ai.kind === 'resumed'
      ? t('tickets:autoReply.event.resumed', { name })
      : ai.reason === null
        ? message.bodyText
        : translate(`tickets:autoReply.event.${ai.reason}`, {
            name,
            confidence: (ai.confidence ?? 0).toFixed(2),
            threshold: (ai.threshold ?? 0).toFixed(2),
          });
  const Icon = ai.kind === 'resumed' ? RotateCcw : handedOff ? UserRound : PauseCircle;

  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <Icon size={14} aria-hidden="true" />
      <span>{sentence}</span>
      <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
        <bdi>{time}</bdi>
      </Typography>
    </Box>
  );
}
