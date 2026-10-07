import type { SystemAiSpend } from '@helpdock/schemas';
import { Box, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { Card } from './card.js';
import { formatCompact, formatUsd, percentOf } from './format.js';

/**
 * "LLM spend by brand" on `Admin/System-1.0` (M8-05): each brand's tokens and
 * cost this month from `ai_calls`, against its own monthly budget, and the
 * install's total under them. Until an AI provider is set up the api says it
 * is not available rather than drawing zeroes.
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

  const rows = [
    ...spend.brands.map((brand) => ({ ...brand, key: brand.brandId, total: false })),
    {
      key: 'install',
      name: t('system:llm.install'),
      tokens: spend.tokens,
      costUsd: spend.costUsd,
      budgetUsd: spend.budgetUsd,
      total: true,
    },
  ];

  return (
    <Card
      title={t('system:llm.title')}
      action={
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:llm.caption')}
        </Typography>
      }
    >
      <Box sx={{ display: 'grid', gap: 3 }}>
        <Table size="small" aria-label={t('system:llm.title')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('system:llm.brand')}</TableCell>
              <TableCell sx={{ textAlign: 'end' }}>{t('system:llm.tokens')}</TableCell>
              <TableCell sx={{ textAlign: 'end' }}>{t('system:llm.cost')}</TableCell>
              <TableCell>{t('system:llm.budget')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell sx={{ fontWeight: row.total ? 600 : 400 }}>{row.name}</TableCell>
                <TableCell sx={{ textAlign: 'end' }}>
                  <Mono>{formatCompact(row.tokens)}</Mono>
                </TableCell>
                <TableCell sx={{ textAlign: 'end' }}>
                  <Mono>{formatUsd(row.costUsd)}</Mono>
                </TableCell>
                <TableCell>
                  <Budget
                    costUsd={row.costUsd}
                    budgetUsd={row.budgetUsd}
                    alertAt={spend.alertAtPercent}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:llm.footer')}
        </Typography>
      </Box>
    </Card>
  );
}

/** "48 % of $100", in the warning hue with an icon once past the alert. */
function Budget({
  costUsd,
  budgetUsd,
  alertAt,
}: {
  readonly costUsd: number;
  readonly budgetUsd: number | null;
  readonly alertAt: number | null;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  if (budgetUsd === null) {
    return (
      <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
        {t('system:llm.noBudget')}
      </Typography>
    );
  }
  const percent = percentOf(costUsd, budgetUsd);
  const pastAlert = alertAt !== null && percent >= alertAt;

  return (
    <Typography
      variant="body2"
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        color: pastAlert ? tokens['status.warning.text'] : 'text.secondary',
      }}
    >
      {pastAlert ? <TriangleAlert size={14} aria-hidden="true" /> : null}
      {t(pastAlert ? 'system:llm.pastAlert' : 'system:llm.ofBudget', {
        percent,
        budget: formatUsd(budgetUsd),
        alert: alertAt,
      })}
    </Typography>
  );
}

function Mono({ children }: { readonly children: string }): ReactNode {
  return (
    <Typography variant="mono" component="span">
      <bdi dir="ltr">{children}</bdi>
    </Typography>
  );
}
