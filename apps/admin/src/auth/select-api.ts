import type { StaffApi } from '../staff/api.js';
import { HttpStaffApi } from '../staff/http-api.js';
import { MockStaffApi } from '../staff/mock-api.js';
import type { AuthApi } from './api.js';
import { HttpAuthApi } from './http-api.js';
import { HttpTransport } from './http-transport.js';
import { MockAuthApi } from './mock-api.js';

export const AUTH_API_ADAPTERS = ['mock', 'http'] as const;
export type AuthApiAdapter = (typeof AUTH_API_ADAPTERS)[number];

/** The two adapters the app is built from, always from the same source. */
export interface AdminApis {
  readonly auth: AuthApi;
  readonly staff: StaffApi;
}

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

/**
 * Both adapters at once, sharing what they have to share: the http pair share
 * one {@link HttpTransport}, so there is one access token and one refresh; the
 * mock pair share one fixture, so an invitation sent on the staff screen is the
 * one the accept screen reads.
 */
export function createApis(
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): AdminApis {
  if (adapter === 'http') {
    const transport = new HttpTransport();

    return { auth: new HttpAuthApi(transport), staff: new HttpStaffApi(transport) };
  }

  const staff = new MockStaffApi();

  return { auth: new MockAuthApi(staff), staff };
}
