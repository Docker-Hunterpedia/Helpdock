import type { NotificationList } from '@helpdock/schemas';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { currentBrand, useSession } from '../auth/session.tsx';
import { useRealtime } from '../realtime/realtime-provider.tsx';
import { useNotificationsApi } from './context.tsx';

/** Every notification query of one brand, so one invalidation refreshes the bell and the panel. */
export const notificationsKey = (brandId: string) => ['notifications', brandId] as const;

/**
 * The current brand's notifications, kept fresh by the socket: a
 * `notification:created` frame for this brand re-reads the list, because
 * "sockets are notifications; REST is the truth" (DOMAIN-RULES §7). A frame
 * about another brand is left for when that brand is on screen.
 */
export function useNotificationList(filter: 'all' | 'unread'): UseQueryResult<NotificationList> {
  const api = useNotificationsApi();
  const brandId = currentBrand(useSession()).id;
  const queryClient = useQueryClient();
  const { client } = useRealtime();

  useEffect(
    () =>
      client.subscribe({
        notificationCreated: (created) => {
          if (created.brandId === brandId) {
            void queryClient.invalidateQueries({ queryKey: notificationsKey(brandId) });
          }
        },
      }),
    [client, brandId, queryClient],
  );

  return useQuery({
    queryKey: [...notificationsKey(brandId), filter],
    queryFn: () => api.list(brandId, filter),
  });
}
