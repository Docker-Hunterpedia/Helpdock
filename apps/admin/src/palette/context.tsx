import { createContext, type ReactNode, useContext } from 'react';
import type { QuickSearchApi } from './api.js';

const QuickSearchApiContext = createContext<QuickSearchApi | null>(null);

export function QuickSearchApiProvider({
  api,
  children,
}: {
  readonly api: QuickSearchApi;
  readonly children: ReactNode;
}): ReactNode {
  return <QuickSearchApiContext.Provider value={api}>{children}</QuickSearchApiContext.Provider>;
}

export function useQuickSearchApi(): QuickSearchApi {
  const api = useContext(QuickSearchApiContext);
  if (!api) {
    throw new Error('useQuickSearchApi needs a <QuickSearchApiProvider> above it');
  }
  return api;
}
