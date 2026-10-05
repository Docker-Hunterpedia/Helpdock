import { Box, Skeleton, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ServerCog, ShieldAlert } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useT } from '../../../app/i18n.js';
import { EmptyState } from '../../../shell/empty-state.js';
import { PageHeader } from '../../../shell/page-header.js';
import { secondsSince } from './format.js';
import { HealthCards } from './health-cards.js';
import { LlmSpendCard } from './llm-spend-card.js';
import { PendingDeletionsCard } from './pending-deletions-card.js';
import { ProductMetricsRow } from './product-metrics-row.js';
import { QueueDashboardButton } from './queue-dashboard-button.js';
import { QueuesCard } from './queues-card.js';
import { AuditCard, ChannelsCard } from './side-cards.js';
import { StorageCard } from './storage-card.js';
import {
  INSTALL_BRANDS_QUERY_KEY,
  NotAllowedError,
  SYSTEM_QUERY_KEY,
  SYSTEM_REFETCH_MS,
  type SystemApi,
} from './system-api.js';
import { useSystemApi } from './system-api-context.tsx';
import { VersionCard } from './version-card.js';

/**
 * The artboard `Admin/System-1.0` (M8-05, M8-07): four health cards, the
 * product metrics, the queue table and the channels beside version, storage
 * and audit, then LLM spend and the brands pending deletion.
 *
 * It refetches every ten seconds rather than holding a socket open. A status
 * page is read for a minute and closed; a poll is what it costs, and it keeps
 * the page working before the realtime gateway exists (M0-13).
 */

export function SystemPage({ api }: { readonly api?: SystemApi } = {}): ReactNode {
  const t = useT();
  const client = useSystemApi(api);

  const { data, error, isPending } = useQuery({
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: () => client.status(),
    refetchInterval: SYSTEM_REFETCH_MS,
    retry: false,
  });
  // Install-wide like the rest; it names the brands in their deletion grace.
  const brands = useQuery({
    queryKey: INSTALL_BRANDS_QUERY_KEY,
    queryFn: () => client.brands(),
    retry: false,
  });
  const pending = useMemo(
    () => (brands.data ?? []).filter((brand) => brand.status === 'deleting'),
    [brands.data],
  );
  const pendingIds = useMemo(() => new Set(pending.map((brand) => brand.id)), [pending]);

  if (error instanceof NotAllowedError) {
    return (
      <>
        <PageHeader title={t('system:title')} />
        <EmptyState
          icon={ShieldAlert}
          heading={t('system:notAllowed.heading')}
          body={t('system:notAllowed.body')}
        />
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHeader title={t('system:title')} />
        <EmptyState
          icon={ServerCog}
          heading={t('system:error.heading')}
          body={t('system:error.body')}
        />
      </>
    );
  }

  if (isPending) {
    return (
      <>
        <PageHeader title={t('system:title')} />
        <Box role="status" aria-live="polite" sx={{ display: 'grid', gap: 4 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('system:loading')}
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
              gap: 4,
            }}
          >
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} variant="rounded" height={96} />
            ))}
          </Box>
          <Skeleton variant="rounded" height={280} />
        </Box>
      </>
    );
  }

  const age = secondsSince(data.observedAt);

  return (
    <>
      <PageHeader
        title={t('system:title')}
        caption={age === 0 ? t('system:captionJustNow') : t('system:caption', { seconds: age })}
        action={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Typography
              variant="mono"
              component="span"
              dir="ltr"
              sx={{ color: 'text.secondary', display: { xs: 'none', md: 'inline' } }}
            >
              {t('system:version', {
                version: data.build.version,
                sha: data.build.gitSha,
                node: data.build.nodeVersion,
              })}
            </Typography>
            <QueueDashboardButton api={client} />
          </Box>
        }
      />

      <Box sx={{ display: 'grid', gap: 6 }}>
        <HealthCards status={data} />

        <ProductMetricsRow api={client} />

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.6fr) minmax(0, 1fr)' },
            gap: 4,
            alignItems: 'start',
          }}
        >
          <Box sx={{ display: 'grid', gap: 4 }}>
            <QueuesCard summary={data.queues} api={client} />
            <ChannelsCard channels={data.channels} />
          </Box>

          <Box sx={{ display: 'grid', gap: 4 }}>
            <VersionCard status={data} />
            <StorageCard storage={data.storage} pendingBrandIds={pendingIds} />
            <AuditCard audit={data.audit} />
          </Box>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
            gap: 4,
            alignItems: 'start',
          }}
        >
          <LlmSpendCard spend={data.aiSpend} />
          <PendingDeletionsCard api={client} pending={pending} />
        </Box>
      </Box>
    </>
  );
}
