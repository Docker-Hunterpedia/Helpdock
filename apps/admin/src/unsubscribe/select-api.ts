import { type AuthApiAdapter, resolveAuthApiAdapter } from '../auth/select-api.js';
import type { UnsubscribeApi } from './api.js';
import { HttpUnsubscribeApi } from './http-api.js';
import { MockUnsubscribeApi } from './mock-api.js';

/**
 * The unsubscribe page's adapter, chosen by the same `VITE_AUTH_API` rule as
 * the rest of the app. It stands apart from `createApis` because the page
 * stands apart from the app: it is mounted without the staff providers.
 */
export function createUnsubscribeApi(
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): UnsubscribeApi {
  return adapter === 'http' ? new HttpUnsubscribeApi() : new MockUnsubscribeApi();
}
