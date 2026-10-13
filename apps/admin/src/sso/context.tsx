import { createContext, type ReactNode, useContext } from 'react';
import type { SsoApi } from './api.js';

const SsoApiContext = createContext<SsoApi | null>(null);
export function SsoApiProvider({ api, children }: { api: SsoApi; children: ReactNode }) {
  return <SsoApiContext.Provider value={api}>{children}</SsoApiContext.Provider>;
}
export function useSsoApi(): SsoApi {
  const api = useContext(SsoApiContext);
  if (!api) throw new Error('useSsoApi needs <SsoApiProvider> above it');
  return api;
}
