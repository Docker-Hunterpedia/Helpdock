import type { TicketAiState } from '@helpdock/schemas';
import { Typography } from '@mui/material';
import { Pause, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * What a ticket list row says about the assistant (M7-06, `Admin/Ticket-AI`,
 * DESIGN §6.2): "AI paused" while the conversation is handed off, the fact the
 * AIPausedStrip carries in the ticket, and "AI answered" once the assistant has
 * taken part and is not paused. The api sends `ai` only for a conversation the
 * assistant took part in, so a ticket without it draws nothing.
 *
 * Both are one caption in `action.primary`, apart in icon and words, as the
 * artboard draws them. DESIGN §6.2 calls the paused one a "Label", but the
 * Label component is a neutral `bg.muted` chip, which the artboard does not
 * draw here.
 */
export function TicketAiMark({ state }: { readonly state: TicketAiState | undefined }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (state === undefined) {
    return null;
  }

  const paused = state.pausedAt !== null;
  const Icon = paused ? Pause : Sparkles;

  return (
    <Typography
      component="span"
      variant="caption"
      sx={{
        display: 'inline-flex',
        flexShrink: 0,
        alignItems: 'center',
        gap: 1,
        marginInlineStart: 1,
        fontWeight: 500,
        color: tokens['action.primary'],
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={14} aria-hidden="true" />
      {t(paused ? 'tickets:list.aiPaused' : 'tickets:list.aiAnswered')}
    </Typography>
  );
}
