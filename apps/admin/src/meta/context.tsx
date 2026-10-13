import { createContext, type ReactNode, useContext } from 'react';
import type { MetaApi } from './api.js';

/**
 * The Meta adapter, in a context of its own as `TelegramApiProvider` is: only
 * Channels › Meta and a Meta ticket read it.
 */
const MetaApiContext = createContext<MetaApi | null>(null);

export function MetaApiProvider({
  api,
  children,
}: {
  readonly api: MetaApi;
  readonly children: ReactNode;
}): ReactNode {
  return <MetaApiContext.Provider value={api}>{children}</MetaApiContext.Provider>;
}

export function useMetaApi(): MetaApi {
  const api = useContext(MetaApiContext);
  if (!api) {
    throw new Error('useMetaApi needs a <MetaApiProvider> above it');
  }
  return api;
}
