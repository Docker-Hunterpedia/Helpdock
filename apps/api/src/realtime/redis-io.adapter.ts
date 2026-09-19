import { SOCKET_IO_PATH } from '@helpdock/schemas';
import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { Logger } from '../logging/logger.js';

/**
 * The Socket.IO server itself: attached to the same HTTP server Fastify is
 * listening on, fanned out across replicas by Redis, and locked down to one
 * transport and one origin.
 *
 * Four decisions, all of them from the planning documents:
 *
 * - **WebSocket only.** "Socket.IO client (only the websocket transport, no
 *   long-polling)" (ARCHITECTURE §12). Long-polling would also make sticky
 *   sessions a deployment requirement, which the Compose file does not provide.
 * - **Redis adapter with two connections.** A subscribed ioredis client may run
 *   no other command, so the publisher cannot be the subscriber. With them,
 *   `to('brand:…')` reaches every replica's sockets; without them a room would
 *   only ever mean "on this process" (ARCHITECTURE §3).
 * - **One origin.** A WebSocket handshake is not covered by the same-origin
 *   policy, so a page anywhere could otherwise open one. `allowRequest` is what
 *   enforces it — the `cors` option only writes response headers, which a
 *   WebSocket client is free to ignore — and a request with no `Origin` at all
 *   is allowed, because that is a server-to-server client rather than a page.
 *   It is defence in depth either way: the credential is the bearer token in
 *   `auth.token` and never a cookie, so a cross-origin page has nothing to
 *   present. The widget's own allow-list is M4-03, on its own namespace.
 * - **No client bundle.** `serveClient: false`; the admin ships its own.
 */
export class RedisIoAdapter extends IoAdapter {
  readonly #appUrl: string;
  readonly #logger: Logger;
  #pub: Redis | null = null;
  #sub: Redis | null = null;

  constructor(
    app: INestApplicationContext,
    options: { readonly appUrl: string; readonly logger: Logger },
  ) {
    super(app);
    this.#appUrl = options.appUrl;
    this.#logger = options.logger;
  }

  /** Opens the pub/sub pair. Called before `app.init()`, which is when gateways bind. */
  async connect(redisUrl: string): Promise<void> {
    const pub = new Redis(redisUrl, { lazyConnect: true });
    const sub = pub.duplicate();
    for (const client of [pub, sub]) {
      client.on('error', (error: Error) => {
        this.#logger.error({ err: error }, 'The Socket.IO Redis adapter connection failed');
      });
    }

    await Promise.all([pub.connect(), sub.connect()]);
    this.#pub = pub;
    this.#sub = sub;
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // `ServerOptions` has every field required; `Partial` is what the runtime
    // actually accepts, and the cast says so once rather than at each key.
    const merged = {
      ...options,
      path: SOCKET_IO_PATH,
      transports: ['websocket'],
      // There is nothing to upgrade from when polling is off, and leaving it on
      // would answer an upgrade probe that can never be used.
      allowUpgrades: false,
      serveClient: false,
      cors: { origin: this.#appUrl, credentials: true, methods: ['GET'] },
      allowRequest: (request, accept) => {
        const origin = request.headers.origin;
        accept(null, origin === undefined || origin === this.#appUrl);
      },
    } satisfies Partial<ServerOptions> as ServerOptions;

    const server = super.createIOServer(port, merged);

    if (this.#pub !== null && this.#sub !== null) {
      server.adapter(createAdapter(this.#pub, unawaitedUnsubscribeIsSafe(this.#sub)));
    } else {
      // A single-replica deploy still works; a multi-replica one silently would
      // not, and "rooms only reach this process" is the kind of failure that is
      // found in production. Say it at boot.
      this.#logger.error('Socket.IO is running without the Redis adapter; rooms are per replica');
    }

    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);

    // Nest holds one entry per server *and* per namespace and closes them
    // concurrently, so this runs more than once. Taking the connections before
    // awaiting anything is what stops the second call quitting them again.
    const [pub, sub] = [this.#pub, this.#sub];
    this.#pub = null;
    this.#sub = null;

    await Promise.all([quietly(pub), quietly(sub)]);
  }
}

/**
 * `@socket.io/redis-adapter` unsubscribes fire-and-forget when a namespace
 * closes. If Redis has already gone — a crash, or a container stopped before
 * the process was — ioredis rejects those commands and there is nobody to catch
 * them, so shutting down ends in an unhandled rejection per namespace.
 *
 * This is the client with those two commands made safe to leave unawaited.
 * Every other method is handed through bound to the real client, so nothing
 * about the connection changes.
 */
export const unawaitedUnsubscribeIsSafe = (client: Redis): Redis =>
  new Proxy(client, {
    get(target, property) {
      // No `receiver`: an accessor reached through the Proxy could not read the
      // client's own private fields, and the value is bound to `target` below.
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') {
        return value;
      }

      const method = value.bind(target) as (...args: unknown[]) => unknown;
      if (property !== 'unsubscribe' && property !== 'punsubscribe') {
        return method;
      }

      return (...args: unknown[]) => Promise.resolve(method(...args)).catch(() => undefined);
    },
  });

/**
 * A shutdown must not fail because the thing it is closing has already gone: a
 * Redis that is down makes `quit` wait for a reply that will never come, and
 * that is a shutdown hanging on a connection nobody needs any more.
 */
export const quietly = async (client: Redis | null): Promise<void> => {
  if (client === null) {
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
};
