import { createContext, type ReactNode, useContext } from 'react';
import type { HelpCenterApi } from './api.js';

/** The help center adapter, in a context of its own for the reason `automation/context.tsx` gives. */
const HelpCenterApiContext = createContext<HelpCenterApi | null>(null);

export function HelpCenterApiProvider({
  api,
  children,
}: {
  readonly api: HelpCenterApi;
  readonly children: ReactNode;
}): ReactNode {
  return <HelpCenterApiContext.Provider value={api}>{children}</HelpCenterApiContext.Provider>;
}

export function useHelpCenterApi(): HelpCenterApi {
  const api = useContext(HelpCenterApiContext);
  if (!api) {
    throw new Error('useHelpCenterApi needs a <HelpCenterApiProvider> above it');
  }
  return api;
}
