import { type AuthApiAdapter, resolveAuthApiAdapter } from '../auth/select-api.js';
import type { CsatApi } from './api.js';
import { HttpCsatApi } from './http-api.js';
import { MockCsatApi } from './mock-api.js';

/**
 * The rating page's adapter, chosen by the same `VITE_AUTH_API` rule as the
 * rest of the app. It stands apart from `createApis` because the page stands
 * apart from the app: it is mounted without the staff providers (`main.tsx`).
 */
export function createCsatApi(
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): CsatApi {
  return adapter === 'http' ? new HttpCsatApi() : new MockCsatApi();
}
