import type { SystemAiSpend } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { UsageMeter } from '../../../ui/usage-meter.js';
import { Card } from './card.js';
import { formatCompact, formatUsd, percentOf } from './format.js';

/**
 * LLM spend on `Admin/System-1.0` (M8-05). The api reports it install-wide
 * through the `AiUsageSource` seam, which M7 binds; until then it says it is
 * not available rather than drawing a zero. The artboard's per-brand rows wait
 * for M7 to report spend per brand.
 */
export function LlmSpendCard({ spend }: { readonly spend: SystemAiSpend }): ReactNode {
  const t = useT();

  if (!spend.configured) {
    return (
      <Card title={t('system:llm.title')}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:llm.unavailable')}
        </Typography>
      </Card>
    );
  }

  const figure = t('system:llm.figure', {
    tokens: formatCompact(spend.tokens),
    cost: formatUsd(spend.costUsd),
  });

  return (
    <Card title={t('system:llm.title')}>
      <Box sx={{ display: 'grid', gap: 3 }}>
        {spend.budgetUsd === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
              {t('system:llm.install')}
            </Typography>
            <Typography variant="mono" component="span">
              <bdi dir="ltr">{figure}</bdi>
            </Typography>
          </Box>
        ) : (
          <UsageMeter
            label={t('system:llm.install')}
            figure={figure}
            percent={percentOf(spend.costUsd, spend.budgetUsd)}
            accessibleLabel={t('system:llm.meterLabel', {
              percent: percentOf(spend.costUsd, spend.budgetUsd),
            })}
            caption={t('system:llm.ofBudget', {
              percent: percentOf(spend.costUsd, spend.budgetUsd),
              budget: formatUsd(spend.budgetUsd),
            })}
          />
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:llm.footer')}
        </Typography>
      </Box>
    </Card>
  );
}
