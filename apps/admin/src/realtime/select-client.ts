import type { AuthApi } from '../auth/api.js';
import { type AuthApiAdapter, resolveAuthApiAdapter } from '../auth/select-api.js';
import type { RealtimeClient } from './client.js';
import { MockRealtimeClient } from './mock-client.js';
import { SocketRealtimeClient } from './socket-client.js';

/**
 * The realtime client follows the auth adapter, because the two cannot disagree:
 * a socket handshake carries the access token the auth adapter holds, so a real
 * socket against a mocked session would have nothing to present and a mocked
 * socket against a real session would show presence nobody has.
 */
export function createRealtimeClient(
  api: AuthApi,
  adapter: AuthApiAdapter = resolveAuthApiAdapter(
    import.meta.env.VITE_AUTH_API,
    import.meta.env.PROD,
  ),
): RealtimeClient {
  return adapter === 'http'
    ? new SocketRealtimeClient({ token: () => api.accessToken() })
    : new MockRealtimeClient();
}
