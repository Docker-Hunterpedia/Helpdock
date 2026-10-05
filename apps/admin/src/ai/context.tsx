import { createContext, type ReactNode, useContext } from 'react';
import type { AiApi } from './api.js';

/**
 * The AI adapter, in a context of its own as `DomainsApiProvider` is: only
 * `Admin/AI` reads it.
 */
const AiApiContext = createContext<AiApi | null>(null);

export function AiApiProvider({
  api,
  children,
}: {
  readonly api: AiApi;
  readonly children: ReactNode;
}): ReactNode {
  return <AiApiContext.Provider value={api}>{children}</AiApiContext.Provider>;
}

export function useAiApi(): AiApi {
  const api = useContext(AiApiContext);
  if (!api) {
    throw new Error('useAiApi needs an <AiApiProvider> above it');
  }
  return api;
}
