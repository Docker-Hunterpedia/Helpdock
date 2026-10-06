import type { AiCallView, TicketMessageAi } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * DESIGN §6.3 AILogDisclosure (M7-06, M7-08, `Admin/Ticket-AI`): what the
 * model call behind a message did, in a native `<details>`. The summary is
 * "AI log · model · cost · confidence"; open, a `dl` of the call's figures
 * from `ai_calls`. Without a call (a handoff no model was asked about) it
 * shows what the message itself knows.
 */

export const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;

type Translate = ReturnType<typeof useT>;

const logRows = (
  ai: TicketMessageAi,
  call: AiCallView | undefined,
  t: Translate,
): [string, string][] => {
  const rows: [string, string][] = [];
  if (call !== undefined) {
    rows.push(
      [t('tickets:autoReply.logModel'), `${call.model} · ${call.provider}`],
      [
        t('tickets:autoReply.logTokens'),
        t('tickets:autoReply.tokensValue', { tokensIn: call.tokensIn, tokensOut: call.tokensOut }),
      ],
      [t('tickets:autoReply.logCost'), formatCost(call.costUsd)],
      [t('tickets:autoReply.logRedactions'), String(call.redactions.length)],
    );
  } else if (ai.model !== null) {
    rows.push([t('tickets:autoReply.logModel'), ai.model]);
  }
  if (ai.confidence !== null) {
    rows.push([
      t('tickets:autoReply.logConfidence'),
      t('tickets:autoReply.confidenceValue', {
        confidence: ai.confidence.toFixed(2),
        threshold: (ai.threshold ?? 0).toFixed(2),
      }),
    ]);
  }
  if (call !== undefined) {
    rows.push([
      t('tickets:autoReply.logSources'),
      t('tickets:autoReply.sourcesValue', {
        retrieved: call.sources.length,
        cited: ai.citations.length,
      }),
    ]);
  }
  return rows;
};

export function AILogDisclosure({
  ai,
  call,
}: {
  readonly ai: TicketMessageAi;
  readonly call: AiCallView | undefined;
}): ReactNode {
  const t = useT();
  const summary = [
    call?.model ?? ai.model,
    call === undefined ? null : formatCost(call.costUsd),
    ai.confidence?.toFixed(2),
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' · ');

  return <AiLogDetails summary={summary} rows={logRows(ai, call, t)} />;
}

/**
 * The disclosure itself, for any AI result that knows its figures: an
 * auto-reply above, an agent assist result (M7-05) in `assist/`.
 */
export function AiLogDetails({
  summary,
  rows,
}: {
  /** "model · cost · confidence", or empty. */
  readonly summary: string;
  readonly rows: readonly (readonly [string, string])[];
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  return (
    <Box
      component="details"
      sx={{
        marginBlockStart: 3,
        borderRadius: '6px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
      }}
    >
      <Box
        component="summary"
        sx={{
          padding: '4px 8px',
          fontSize: 12,
          lineHeight: '16px',
          fontWeight: 500,
          color: 'text.secondary',
          cursor: 'pointer',
        }}
      >
        {t('tickets:autoReply.log')}
        {summary === '' ? null : (
          <Typography variant="mono" component="span" sx={{ fontSize: 12, marginInlineStart: 2 }}>
            <bdi>{summary}</bdi>
          </Typography>
        )}
      </Box>
      <Box
        component="dl"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          columnGap: 4,
          rowGap: 1,
          margin: 0,
          padding: '4px 8px 8px',
        }}
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
              sx={{ margin: 0, fontSize: 12, lineHeight: '16px' }}
            >
              <bdi>{value}</bdi>
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
