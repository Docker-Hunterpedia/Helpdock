import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { HttpSystemApi, type SystemApi } from './system-api.js';

/**
 * The install-admin adapter: the System page, its queue and audit pages, and
 * Brand › Danger zone's deletion (M8-07). `createApis` builds it on the app's
 * transport so it sends the same access token as every other screen.
 */
const SystemApiContext = createContext<SystemApi | null>(null);

export function SystemApiProvider({
  api,
  children,
}: {
  readonly api: SystemApi;
  readonly children: ReactNode;
}): ReactNode {
  return <SystemApiContext.Provider value={api}>{children}</SystemApiContext.Provider>;
}

/**
 * The adapter a test passed, else the app's, else a bare one for a screen
 * rendered without the providers.
 */
export function useSystemApi(override?: SystemApi): SystemApi {
  const provided = useContext(SystemApiContext);

  return useMemo(() => override ?? provided ?? new HttpSystemApi(), [override, provided]);
}
