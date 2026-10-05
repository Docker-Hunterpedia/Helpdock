import type { ProductMetrics } from '@helpdock/schemas';
import { Box, Skeleton, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { formatShare } from '../../../ui/format.js';
import { MetricTile } from '../../../ui/metric-tile.js';
import { formatCount } from './format.js';
import { activationDay, installDeflection, installSelfService } from './product-metrics.js';
import { PRODUCT_METRICS_QUERY_KEY, type SystemApi } from './system-api.js';

/**
 * The Product metrics row of `Admin/System-1.0` (M8-07): activation, AI
 * deflection and help center self-service, as the release checklist reads
 * them (DOMAIN-RULES §15).
 */
export function ProductMetricsRow({ api }: { readonly api: SystemApi }): ReactNode {
  const t = useT();
  const metrics = useQuery({
    queryKey: PRODUCT_METRICS_QUERY_KEY,
    queryFn: () => api.productMetrics(),
    retry: false,
  });

  return (
    <Box
      component="section"
      aria-labelledby="product-metrics-heading"
      sx={{ display: 'grid', gap: 3 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
        <Typography id="product-metrics-heading" variant="h3" component="h2">
          {t('system:metrics.title')}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {t('system:metrics.caption', { days: metrics.data?.windowDays ?? 30 })}
        </Typography>
      </Box>

      {metrics.isError ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('system:metrics.failed')}
        </Typography>
      ) : null}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
          gap: 3,
        }}
      >
        {metrics.data === undefined ? (
          metrics.isPending ? (
            [0, 1, 2].map((index) => <Skeleton key={index} variant="rounded" height={112} />)
          ) : null
        ) : (
          <MetricTiles metrics={metrics.data} />
        )}
      </Box>
    </Box>
  );
}

function MetricTiles({ metrics }: { readonly metrics: ProductMetrics }): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const day = activationDay(metrics.activation);
  const selfService = installSelfService(metrics.brands);
  const deflection = installDeflection(metrics.brands);

  return (
    <>
      <MetricTile
        label={t('system:metrics.activation.label')}
        figure={day === null ? '—' : t('system:metrics.activation.day', { day })}
        caption={
          day === null
            ? t('system:metrics.activation.waiting')
            : t('system:metrics.activation.caption', { day })
        }
        badge={
          metrics.activation.activated ? (
            <Typography variant="caption" sx={{ color: tokens['status.success.text'] }}>
              {t('system:metrics.activation.activated')}
            </Typography>
          ) : null
        }
      />
      <MetricTile
        label={t('system:metrics.deflection.label')}
        figure={deflection.rate === null ? '—' : formatShare(deflection.rate)}
        caption={
          deflection.rate === null
            ? t('system:metrics.deflection.unavailable')
            : t('system:metrics.deflection.caption', { count: deflection.brands })
        }
      />
      <MetricTile
        label={t('system:metrics.selfService.label')}
        figure={selfService.rate === null ? '—' : formatShare(selfService.rate)}
        caption={t('system:metrics.selfService.caption')}
        badge={
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {t('system:metrics.selfService.views', {
              views: formatCount(selfService.articleViews),
            })}
          </Typography>
        }
      />
    </>
  );
}
