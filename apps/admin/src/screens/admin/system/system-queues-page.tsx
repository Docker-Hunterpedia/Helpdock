import { Box, Button } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ServerCog, ShieldAlert } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { Link as RouterLink } from 'react-router';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { EmptyState } from '../../../shell/empty-state.js';
import { PageHeader } from '../../../shell/page-header.js';
import { QueuesCard } from './queues-card.js';
import {
  HttpSystemApi,
  NotAllowedError,
  SYSTEM_QUERY_KEY,
  SYSTEM_REFETCH_MS,
  type SystemApi,
} from './system-api.js';

/**
 * Where "Open queue dashboard" goes until Bull Board is embedded (M8-05, ADR
 * 0004): the same queue table, on its own and already showing every queue.
 */
export function SystemQueuesPage({ api }: { readonly api?: SystemApi } = {}): ReactNode {
  const t = useT();
  const client = useMemo(() => api ?? new HttpSystemApi(), [api]);

  const { data, error } = useQuery({
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: () => client.status(),
    refetchInterval: SYSTEM_REFETCH_MS,
    retry: false,
  });

  const back = (
    <Button
      component={RouterLink}
      to={ROUTES.system}
      variant="outlined"
      size="small"
      startIcon={<ArrowLeft size={16} aria-hidden="true" />}
    >
      {t('common:actions.back')}
    </Button>
  );

  if (error) {
    const notAllowed = error instanceof NotAllowedError;

    return (
      <>
        <PageHeader title={t('system:queues.title')} action={back} />
        <EmptyState
          icon={notAllowed ? ShieldAlert : ServerCog}
          heading={t(notAllowed ? 'system:notAllowed.heading' : 'system:error.heading')}
          body={t(notAllowed ? 'system:notAllowed.body' : 'system:error.body')}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('system:queues.title')}
        caption={t('system:openQueuesHint')}
        action={back}
      />
      <Box sx={{ display: 'grid', gap: 4 }}>
        {data === undefined ? null : <QueuesCard summary={data.queues} api={client} showAll />}
      </Box>
    </>
  );
}
