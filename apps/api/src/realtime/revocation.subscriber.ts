import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { PRINCIPAL_REVOKED_CHANNEL } from '../auth/redis-keys.js';
import type { Logger } from '../logging/logger.js';
import { LOGGER, REDIS } from '../runtime/tokens.js';
import { quietly } from './redis-io.adapter.js';
import { SocketRegistry } from './socket-registry.js';

/**
 * "On role change, deactivation, or 'log out everywhere', the server publishes
 * `principal.revoked` over Redis and every replica disconnects that principal's
 * sockets within 5 seconds" (DOMAIN-RULES §1.4).
 *
 * M0-05 publishes; this subscribes. The budget is five seconds and the actual
 * latency is one Redis round trip, because the work is local: the registry
 * already knows which of this replica's sockets belong to that person.
 *
 * The connection is a dedicated one. A subscribed ioredis client may run no
 * other command, and the Socket.IO adapter has subscriptions of its own on
 * connections it owns; sharing either would mean two components reading each
 * other's messages.
 */
@Injectable()
export class RevocationSubscriber implements OnModuleInit, OnModuleDestroy {
  readonly #redis: Redis;
  readonly #registry: SocketRegistry;
  readonly #logger: Logger;
  #subscriber: Redis | null = null;

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(SocketRegistry) registry: SocketRegistry,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.#redis = redis;
    this.#registry = registry;
    this.#logger = logger;
  }

  async onModuleInit(): Promise<void> {
    const subscriber = this.#redis.duplicate();
    subscriber.on('error', (error: Error) => {
      this.#logger.error({ err: error }, 'The principal.revoked subscriber failed');
    });
    subscriber.on('message', (channel: string, message: string) => {
      if (channel === PRINCIPAL_REVOKED_CHANNEL) {
        this.disconnectRevoked(message);
      }
    });

    await subscriber.subscribe(PRINCIPAL_REVOKED_CHANNEL);
    this.#subscriber = subscriber;
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.#subscriber;
    this.#subscriber = null;
    await quietly(subscriber);
  }

  /**
   * Exported past `#` so a test can deliver a message without a Redis. The
   * payload is parsed rather than trusted: it crosses a process boundary, and
   * anything with `PUBLISH` on this Redis can write to the channel.
   */
  disconnectRevoked(message: string): void {
    const parsed = revokedSchema.safeParse(safeJson(message));
    if (!parsed.success) {
      this.#logger.warn('Ignored a malformed principal.revoked message');
      return;
    }

    const sockets = this.#registry.socketsOf(parsed.data.principalId);
    for (const socket of sockets) {
      // `emit` before `disconnect`, so the client knows why it is being closed
      // and shows "signed out elsewhere" rather than reconnecting in a loop.
      socket.emit('revoked', { code: 'session_revoked', message: parsed.data.reason });
      socket.disconnect(true);
    }

    if (sockets.length > 0) {
      this.#logger.info(
        { userId: parsed.data.principalId, sockets: sockets.length, reason: parsed.data.reason },
        'Disconnected sockets of a revoked principal',
      );
    }
  }
}

/** The payload `SessionService` publishes. */
const revokedSchema = z.object({
  principalType: z.literal('staff'),
  principalId: z.uuid(),
  reason: z.string(),
});

const safeJson = (message: string): unknown => {
  try {
    return JSON.parse(message);
  } catch {
    return null;
  }
};
