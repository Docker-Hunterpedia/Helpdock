import type { AssistCallMeta } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { formatUsd } from './format.js';

/**
 * DESIGN §6.3 AILogDisclosure (M7-08): what a model call did, under every
 * assist result — a native `details` whose summary reads "AI log · model ·
 * cost", and whose `dl` gives model, tokens, cost and redactions from the
 * call's `ai_calls` row.
 */
export function AILogDisclosure({ meta }: { readonly meta: AssistCallMeta }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  const rows: readonly [string, string][] = [
    [t('tickets:assist.log.model'), `${meta.model} · ${meta.provider}`],
    [
      t('tickets:assist.log.tokens'),
      t('tickets:assist.log.tokensValue', { in: meta.tokensIn, out: meta.tokensOut }),
    ],
    [t('tickets:assist.log.cost'), formatUsd(meta.costUsd)],
    [
      t('tickets:assist.log.redactions'),
      meta.redactionCount === 0
        ? '0'
        : `${String(meta.redactionCount)} · ${meta.redactionKinds
            .map((kind) => t(`tickets:assist.piiKinds.${kind}`))
            .join(', ')}`,
    ],
  ];

  return (
    <Box
      component="details"
      sx={{
        borderRadius: '6px',
        backgroundColor: tokens['bg.canvas'],
        border: `1px solid ${tokens['border.default']}`,
        '& > summary': {
          cursor: 'pointer',
          padding: '4px 8px',
          fontSize: 12,
          fontWeight: 500,
          color: 'text.secondary',
        },
      }}
    >
      <summary>
        {t('tickets:assist.log.title')}
        <Typography variant="mono" component="span" sx={{ fontSize: 12, marginInlineStart: 1 }}>
          {`· ${meta.model} · ${formatUsd(meta.costUsd)}`}
        </Typography>
      </summary>
      <Box
        component="dl"
        sx={(theme) => ({
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          columnGap: 4,
          rowGap: 1,
          margin: 0,
          padding: '4px 8px 8px',
          fontSize: 12,
          lineHeight: '16px',
          '& dt': { color: 'text.secondary' },
          '& dd': { margin: 0, fontFamily: theme.typography.mono.fontFamily },
        })}
      >
        {rows.map(([term, value]) => (
          <Box key={term} sx={{ display: 'contents' }}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
