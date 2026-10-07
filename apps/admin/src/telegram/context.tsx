import { createContext, type ReactNode, useContext } from 'react';
import type { TelegramApi } from './api.js';

/**
 * The Telegram adapter, in a context of its own as `DomainsApiProvider` is:
 * only Channels › Telegram and a Telegram ticket read it.
 */
const TelegramApiContext = createContext<TelegramApi | null>(null);

export function TelegramApiProvider({
  api,
  children,
}: {
  readonly api: TelegramApi;
  readonly children: ReactNode;
}): ReactNode {
  return <TelegramApiContext.Provider value={api}>{children}</TelegramApiContext.Provider>;
}

export function useTelegramApi(): TelegramApi {
  const api = useContext(TelegramApiContext);
  if (!api) {
    throw new Error('useTelegramApi needs a <TelegramApiProvider> above it');
  }
  return api;
}
