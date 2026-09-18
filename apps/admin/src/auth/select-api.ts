import type { AuthApi } from './api.js';
import { HttpAuthApi } from './http-api.js';
import { MockAuthApi } from './mock-api.js';

export const AUTH_API_ADAPTERS = ['mock', 'http'] as const;
export type AuthApiAdapter = (typeof AUTH_API_ADAPTERS)[number];

/**
 * `VITE_AUTH_API` wins when it names an adapter. Without it a production build
 * gets the real service and everything else gets the fixture, so shipping the
 * mock to an install takes a deliberate `VITE_AUTH_API=mock`.
 */
export function resolveAuthApiAdapter(
  configured: string | undefined,
  production: boolean,
): AuthApiAdapter {
  const named = AUTH_API_ADAPTERS.find((adapter) => adapter === configured);

  return named ?? (production ? 'http' : 'mock');
}

export function createAuthApi(
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): AuthApi {
  return adapter === 'http' ? new HttpAuthApi() : new MockAuthApi();
}
