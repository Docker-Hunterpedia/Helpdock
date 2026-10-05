import { createContext, type ReactNode, useContext } from 'react';
import type { KnowledgeApi } from './api.js';

/** The knowledge adapter, in a context of its own: only AI › Knowledge reads it. */
const KnowledgeApiContext = createContext<KnowledgeApi | null>(null);

export function KnowledgeApiProvider({
  api,
  children,
}: {
  readonly api: KnowledgeApi;
  readonly children: ReactNode;
}): ReactNode {
  return <KnowledgeApiContext.Provider value={api}>{children}</KnowledgeApiContext.Provider>;
}

export function useKnowledgeApi(): KnowledgeApi {
  const api = useContext(KnowledgeApiContext);
  if (!api) {
    throw new Error('useKnowledgeApi needs a <KnowledgeApiProvider> above it');
  }
  return api;
}
