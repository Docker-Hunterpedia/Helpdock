import { createContext, type ReactNode, useContext } from 'react';
import type { ReportsApi } from './api.js';

/** The reports adapter, in a context of its own: only `Admin/Reports` reads it. */
const ReportsApiContext = createContext<ReportsApi | null>(null);

export function ReportsApiProvider({
  api,
  children,
}: {
  readonly api: ReportsApi;
  readonly children: ReactNode;
}): ReactNode {
  return <ReportsApiContext.Provider value={api}>{children}</ReportsApiContext.Provider>;
}

export function useReportsApi(): ReportsApi {
  const api = useContext(ReportsApiContext);
  if (!api) {
    throw new Error('useReportsApi needs a <ReportsApiProvider> above it');
  }
  return api;
}
