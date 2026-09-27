import { createContext, type ReactNode, useContext } from 'react';
import type { DomainsApi } from './api.js';

/**
 * The domains adapter, in a context of its own rather than one more prop on
 * `AuthApiProvider`, as `AutomationApiProvider` is: only Brand › Domains reads
 * it.
 */
const DomainsApiContext = createContext<DomainsApi | null>(null);

export function DomainsApiProvider({
  api,
  children,
}: {
  readonly api: DomainsApi;
  readonly children: ReactNode;
}): ReactNode {
  return <DomainsApiContext.Provider value={api}>{children}</DomainsApiContext.Provider>;
}

export function useDomainsApi(): DomainsApi {
  const api = useContext(DomainsApiContext);
  if (!api) {
    throw new Error('useDomainsApi needs a <DomainsApiProvider> above it');
  }
  return api;
}
