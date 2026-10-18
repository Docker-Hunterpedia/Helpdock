import { createContext, type ReactNode, useContext } from 'react';
import type { ImportsApi } from './api.js';

const ImportsContext = createContext<ImportsApi | null>(null);
export function ImportsApiProvider({ api, children }: { api: ImportsApi; children: ReactNode }) {
  return <ImportsContext.Provider value={api}>{children}</ImportsContext.Provider>;
}
export function useImportsApi(): ImportsApi {
  const api = useContext(ImportsContext);
  if (!api) throw new Error('useImportsApi needs <ImportsApiProvider> above it');
  return api;
}
