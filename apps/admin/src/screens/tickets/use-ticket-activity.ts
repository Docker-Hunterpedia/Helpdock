import type { TicketDetail } from '@helpdock/schemas';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TicketsApi } from '../../tickets/api.js';
import { ticketKeys } from '../../tickets/keys.js';

/** Keep only the current older page; the cursor stack does not retain hundreds of historical payloads. */
export function useTicketActivity(
  api: TicketsApi,
  brandId: string,
  ticketId: string,
  detail: TicketDetail | undefined,
) {
  const identity = `${brandId}:${ticketId}`;
  const [position, setPosition] = useState<{ identity: string; cursors: (string | undefined)[] }>({
    identity,
    cursors: [undefined],
  });
  const cursors = position.identity === identity ? position.cursors : [undefined];
  const before = cursors.at(-1);
  const cache = useQueryClient();
  const page = useQuery({
    queryKey: ['ticket-activity', brandId, ticketId, before],
    queryFn: () => api.activity(brandId, ticketId, { ...(before ? { before } : {}), limit: 100 }),
    enabled: before !== undefined,
    gcTime: 0,
    retry: false,
  });
  const next = before === undefined ? detail?.activityNextBefore : page.data?.nextBefore;
  return {
    entries: before === undefined ? (detail?.activity ?? []) : (page.data?.activity ?? []),
    older: before !== undefined,
    hasOlder: typeof next === 'string',
    loading: before !== undefined && page.isFetching,
    failed: before !== undefined && page.isError,
    loadOlder: () => {
      if (typeof next === 'string') setPosition({ identity, cursors: [...cursors, next] });
    },
    loadNewer: () => setPosition({ identity, cursors: cursors.slice(0, -1) }),
    latest: () => {
      setPosition({ identity, cursors: [undefined] });
      void cache.invalidateQueries({ queryKey: ticketKeys.detail(brandId, ticketId) });
    },
  };
}
