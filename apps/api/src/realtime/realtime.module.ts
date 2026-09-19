import { type DynamicModule, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from '../logging/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { METRICS } from '../observability/tokens.js';
import { LOGGER, REDIS } from '../runtime/tokens.js';
import type { SocketSessionResolver } from './handshake.js';
import type { SocketConnectionsGauge } from './metrics.js';
import { PresenceController } from './presence.controller.js';
import { PresenceService } from './presence.service.js';
import { PresenceStore } from './presence.store.js';
import { RealtimePublisher } from './publisher.js';
import { RevocationSubscriber } from './revocation.subscriber.js';
import { SocketRegistry } from './socket-registry.js';
import { type SessionRevocations, StaffGateway } from './staff.gateway.js';
import { NoopStaffOfflineHook, type StaffOfflineHook } from './staff-offline.hook.js';
import {
  SESSION_REVOCATIONS,
  SOCKET_CONNECTIONS_GAUGE,
  SOCKET_SESSION_RESOLVER,
  STAFF_OFFLINE_HOOK,
} from './tokens.js';

export interface RealtimeModuleOptions {
  /**
   * The process logger, as a value for the same reason `AuthModule` takes one:
   * `LOGGER` is a provider of `AppModule` itself, which an imported module
   * cannot see.
   */
  readonly logger: Logger;
  /** `SessionPrincipalResolver`, so the handshake is the HTTP check verbatim. */
  readonly sessionResolver: SocketSessionResolver;
  /** `RefreshStore`, so a room join can re-ask whether the session still exists. */
  readonly revocations: SessionRevocations;
  /** Defaults to M0-10's `socket_connections`. The unit tests pass a readable one. */
  readonly connectionsGauge?: SocketConnectionsGauge;
  /** M1-07 replaces this with the fifteen-minute auto-unassign timer. */
  readonly staffOfflineHook?: StaffOfflineHook;
}

/**
 * M0-13, in one import: the `/staff` namespace, the room authorization hook,
 * presence and the revocation subscriber (ARCHITECTURE §8, DOMAIN-RULES §1.4,
 * §7 and §12).
 *
 * The Socket.IO server itself is not here. It is created by
 * {@link ./redis-io.adapter.js RedisIoAdapter}, which has to be installed on
 * the application before `init()` because that is when Nest binds gateways to
 * it — one of the few things that cannot be a provider.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions): DynamicModule {
    return {
      module: RealtimeModule,
      controllers: [PresenceController],
      providers: [
        { provide: LOGGER, useValue: options.logger },
        { provide: SOCKET_SESSION_RESOLVER, useValue: options.sessionResolver },
        { provide: SESSION_REVOCATIONS, useValue: options.revocations },
        options.connectionsGauge === undefined
          ? {
              provide: SOCKET_CONNECTIONS_GAUGE,
              inject: [METRICS],
              useFactory: (metrics: Metrics) => metrics.socketConnections,
            }
          : { provide: SOCKET_CONNECTIONS_GAUGE, useValue: options.connectionsGauge },
        {
          provide: STAFF_OFFLINE_HOOK,
          useValue: options.staffOfflineHook ?? new NoopStaffOfflineHook(),
        },
        {
          provide: PresenceStore,
          useFactory: (redis: Redis) => new PresenceStore(redis),
          inject: [REDIS],
        },
        PresenceService,
        RealtimePublisher,
        SocketRegistry,
        RevocationSubscriber,
        // `@UseFilters(AckExceptionFilter)` on the gateway is enough for Nest to
        // build the filter out of this module; listing it here as well would
        // only create a second instance of it.
        StaffGateway,
      ],
      exports: [RealtimePublisher, PresenceService],
    };
  }
}
