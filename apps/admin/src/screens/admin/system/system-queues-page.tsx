import { Box } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { ServerCog, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { EmptyState } from '../../../shell/empty-state.js';
import { PageHeader } from '../../../shell/page-header.js';
import { QueuesCard } from './queues-card.js';
import {
  NotAllowedError,
  SYSTEM_QUERY_KEY,
  SYSTEM_REFETCH_MS,
  type SystemApi,
} from './system-api.js';
import { useSystemApi } from './system-api-context.tsx';

/**
 * Where "Open queue dashboard" goes until Bull Board is embedded (M8-05, ADR
 * 0004): the same queue table, on its own and already showing every queue.
 */
export function SystemQueuesPage({ api }: { readonly api?: SystemApi } = {}): ReactNode {
  const t = useT();
  const client = useSystemApi(api);

  const { data, error } = useQuery({
    queryKey: SYSTEM_QUERY_KEY,
    queryFn: () => client.status(),
    refetchInterval: SYSTEM_REFETCH_MS,
    retry: false,
  });

  if (error) {
    const notAllowed = error instanceof NotAllowedError;

    return (
      <>
        <PageHeader title={t('system:queues.title')} />
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
      <PageHeader title={t('system:queues.title')} caption={t('system:queues.pageCaption')} />
      <Box sx={{ display: 'grid', gap: 4 }}>
        {data === undefined ? null : <QueuesCard summary={data.queues} api={client} showAll />}
      </Box>
    </>
  );
}
