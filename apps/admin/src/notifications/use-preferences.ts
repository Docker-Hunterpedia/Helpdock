import type { NotificationPreferencesView } from '@helpdock/schemas';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { useNotificationsApi } from './context.tsx';

/** The query behind the Notifications tab, shared with the bell's status line. */
export const PREFERENCES_KEY = ['me', 'notification-preferences'] as const;

export function useNotificationPreferences(): UseQueryResult<NotificationPreferencesView> {
  const api = useNotificationsApi();

  return useQuery({ queryKey: PREFERENCES_KEY, queryFn: () => api.preferences() });
}
