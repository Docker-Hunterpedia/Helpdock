import type { AiCallView } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { formatCost } from './ai-log-disclosure.tsx';

/**
 * The DetailsPanel's "AI on this ticket" (DESIGN §6.3 AILogDisclosure,
 * `Admin/Ticket-AI`): how many model calls the ticket made, their tokens and
 * their cost, from its AI log.
 */
export function AiUsageCard({ calls }: { readonly calls: readonly AiCallView[] }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const totals = calls.reduce(
    (sum, call) => ({
      tokens: sum.tokens + call.tokensIn + call.tokensOut,
      costUsd: sum.costUsd + call.costUsd,
    }),
    { tokens: 0, costUsd: 0 },
  );
  const rows: [string, string][] = [
    [t('tickets:autoReply.calls'), String(calls.length)],
    [t('tickets:autoReply.tokens'), totals.tokens.toLocaleString('en-US')],
    [t('tickets:autoReply.cost'), formatCost(totals.costUsd)],
  ];

  return (
    <Box
      component="section"
      aria-labelledby="ai-usage-heading"
      sx={{
        padding: 4,
        borderRadius: '6px',
        border: `1px solid ${tokens['border.default']}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Typography
        id="ai-usage-heading"
        component="h3"
        sx={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 13, fontWeight: 600 }}
      >
        <Sparkles size={16} aria-hidden="true" />
        {t('tickets:autoReply.card')}
      </Typography>
      <Box
        component="dl"
        sx={{ display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 1, margin: 0 }}
      >
        {rows.map(([term, value]) => (
          <Box key={term} sx={{ display: 'contents' }}>
            <Typography
              component="dt"
              sx={{ fontSize: 12, lineHeight: '16px', color: 'text.secondary' }}
            >
              {term}
            </Typography>
            <Typography
              variant="mono"
              component="dd"
              sx={{ margin: 0, fontSize: 12, lineHeight: '16px', textAlign: 'end' }}
            >
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
