import { createContext, type ReactNode, useContext } from 'react';
import type { AssistApi } from './api.js';

/**
 * The assist adapter, in a context of its own as `TelegramApiProvider` is:
 * only the ticket view and Help center › Proposals read it.
 */
const AssistApiContext = createContext<AssistApi | null>(null);

export function AssistApiProvider({
  api,
  children,
}: {
  readonly api: AssistApi;
  readonly children: ReactNode;
}): ReactNode {
  return <AssistApiContext.Provider value={api}>{children}</AssistApiContext.Provider>;
}

export function useAssistApi(): AssistApi {
  const api = useContext(AssistApiContext);
  if (!api) {
    throw new Error('useAssistApi needs an <AssistApiProvider> above it');
  }
  return api;
}
