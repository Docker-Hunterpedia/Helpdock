import { createContext, type ReactNode, useContext } from 'react';
import type { DevelopersApi } from './api.js';

/**
 * The Developers adapter, in a context of its own as `DomainsApiProvider` is:
 * only the Developers page reads it.
 */
const DevelopersApiContext = createContext<DevelopersApi | null>(null);

export function DevelopersApiProvider({
  api,
  children,
}: {
  readonly api: DevelopersApi;
  readonly children: ReactNode;
}): ReactNode {
  return <DevelopersApiContext.Provider value={api}>{children}</DevelopersApiContext.Provider>;
}

export function useDevelopersApi(): DevelopersApi {
  const api = useContext(DevelopersApiContext);
  if (!api) {
    throw new Error('useDevelopersApi needs a <DevelopersApiProvider> above it');
  }
  return api;
}
