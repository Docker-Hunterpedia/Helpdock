import { createContext, type ReactNode, useContext } from 'react';
import type { NotificationsApi } from './api.js';
import type { BrowserPush } from './browser-push.js';

/**
 * The two adapters M3-07's screens read: the api, and this browser's push
 * half. A context of their own rather than two more slots on
 * `AuthApiProvider`, which is about the session.
 */

interface NotificationsAdapters {
  readonly api: NotificationsApi;
  readonly push: BrowserPush;
}

const NotificationsContext = createContext<NotificationsAdapters | null>(null);

export function NotificationsProvider({
  api,
  push,
  children,
}: NotificationsAdapters & { readonly children: ReactNode }): ReactNode {
  return (
    <NotificationsContext.Provider value={{ api, push }}>{children}</NotificationsContext.Provider>
  );
}

const useAdapters = (): NotificationsAdapters => {
  const adapters = useContext(NotificationsContext);
  if (!adapters) {
    throw new Error('the notification screens need a <NotificationsProvider> above them');
  }

  return adapters;
};

export const useNotificationsApi = (): NotificationsApi => useAdapters().api;
export const useBrowserPush = (): BrowserPush => useAdapters().push;
