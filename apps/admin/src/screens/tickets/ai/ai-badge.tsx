import { tokens as designTokens } from '@helpdock/ui';
import { Box } from '@mui/material';
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.2 AIBadge (M7-06, `Admin/Ticket-AI`): a 20 px chip in the author
 * line of everything the model wrote. The author is named in words beside it,
 * so it confirms rather than carries the fact.
 */
export function AIBadge(): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const teal = designTokens.palette.teal;

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        height: 20,
        paddingInline: '6px',
        borderRadius: '6px',
        backgroundColor: tokens['action.primary.tint'],
        border: `1px solid ${teal.teal200}`,
        color: teal.teal700,
        fontSize: 12,
        lineHeight: '16px',
        fontWeight: 600,
      }}
    >
      <Sparkles size={14} aria-hidden="true" />
      {t('tickets:autoReply.badge')}
    </Box>
  );
}
