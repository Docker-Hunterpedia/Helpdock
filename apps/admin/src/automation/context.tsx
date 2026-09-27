import { createContext, type ReactNode, useContext } from 'react';
import type { AutomationApi } from './api.js';

/**
 * The automation adapter, in a context of its own rather than one more prop on
 * `AuthApiProvider`: only `Admin/Automation` reads it, and a screen that never
 * mounts it never needs one.
 */
const AutomationApiContext = createContext<AutomationApi | null>(null);

export function AutomationApiProvider({
  api,
  children,
}: {
  readonly api: AutomationApi;
  readonly children: ReactNode;
}): ReactNode {
  return <AutomationApiContext.Provider value={api}>{children}</AutomationApiContext.Provider>;
}

export function useAutomationApi(): AutomationApi {
  const api = useContext(AutomationApiContext);
  if (!api) {
    throw new Error('useAutomationApi needs an <AutomationApiProvider> above it');
  }
  return api;
}
