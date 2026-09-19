import { Box, Button, Skeleton, Tooltip, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ServerCog, ShieldAlert } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { EmptyState } from '../../../shell/empty-state.js';
import { PageHeader } from '../../../shell/page-header.js';
import { secondsSince } from './format.js';
import { HealthCards } from './health-cards.js';
import { QueuesCard } from './queues-card.js';
import { AuditCard, ChannelsCard, UsageCard } from './side-cards.js';
import {
  HttpSystemApi,
  NotAllowedError,
  SYSTEM_QUERY_KEY,
  SYSTEM_REFETCH_MS,
  type SystemApi,
} from './system-api.js';

/**
 * The artboard `Admin/System`: four health cards, a queue table, and a column
 * of channels, usage and audit.
 *
 * It refetches every ten seconds rather than holding a socket open. A status
 * page is read for a minute and closed; a poll is what it costs, and it keeps
 * the page working before the realtime gateway exists (M0-13).
 */

export function SystemPage({ api }: { readonly api?: SystemApi } = {}): ReactNode {
  const t = useT();
  const client = useMemo(() => api ?? new HttpSystemApi(), [api]);

  const { data, error, isPending } = useQuery({
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: () => client.status(),
    refetchInterval: SYSTEM_REFETCH_MS,
    retry: false,
  });

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
            {/* Bull Board is M8-05 (ADR 0004); until then the button opens the
                full queue table, and the tooltip says so rather than letting a
                label promise a screen that is not there yet. */}
            {/* `describeChild`: without it MUI puts the tooltip text in
                `aria-label`, which replaces the button's visible label as its
                accessible name — the Label-in-Name failure of WCAG 2.5.3. As a
                description it is what DESIGN §6.4 asks for instead. */}
            <Tooltip title={t('system:openQueuesHint')} describeChild>
              <Button
                component={RouterLink}
                to={ROUTES.systemQueues}
                variant="outlined"
                size="small"
              >
                {t('system:openQueues')}
              </Button>
            </Tooltip>
          </Box>
        }
      />

      <HealthCards status={data} />

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: '1.6fr 1fr' },
          gap: 4,
          alignItems: 'start',
        }}
      >
        <QueuesCard summary={data.queues} api={client} />

        <Box sx={{ display: 'grid', gap: 4 }}>
          <ChannelsCard channels={data.channels} />
          <UsageCard storage={data.storage} aiSpend={data.aiSpend} />
          <AuditCard audit={data.audit} />
        </Box>
      </Box>
    </>
  );
}
