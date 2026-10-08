import { createContext, type ReactNode, useContext } from 'react';
import type { SettingsApi } from './api.js';

const SettingsApiContext = createContext<SettingsApi | null>(null);

export function SettingsApiProvider({
  api,
  children,
}: {
  readonly api: SettingsApi;
  readonly children: ReactNode;
}): ReactNode {
  return <SettingsApiContext.Provider value={api}>{children}</SettingsApiContext.Provider>;
}

export function useSettingsApi(): SettingsApi {
  const api = useContext(SettingsApiContext);
  if (!api) {
    throw new Error('useSettingsApi needs a <SettingsApiProvider> above it');
  }
  return api;
}
