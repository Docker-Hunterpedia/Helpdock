import type { Env } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { readRelayStatus } from '@helpdock/jobs';
import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from '../logging/logger.js';
import { ReadinessService } from '../runtime/readiness.service.js';
import { DB, ENV, REDIS } from '../runtime/tokens.js';
import type { BootFacts } from './boot-facts.js';
import { MetricsController } from './metrics.controller.js';
import { createMetrics, type Metrics } from './metrics.js';
import {
  MetricsSampler,
  recordDependency,
  recordPoolConnections,
  recordQueueCounts,
  recordRelayStatus,
} from './metrics-sampler.js';
import { QueueRegistry } from './queues.js';
import { SystemController } from './system.controller.js';
import { SystemService } from './system.service.js';
import { readPostgresFacts } from './system-facts.js';
import { checkReached } from './system-view.js';
import { BOOT_FACTS, METRICS, OBSERVABILITY_LOGGER, QUEUE_REGISTRY } from './tokens.js';

/**
 * M0-10: `/health`, `/ready`, `/metrics`, the gauges behind them and the System
 * page's read (ARCHITECTURE §14).
 *
 * Tracing is deliberately not here. The OpenTelemetry SDK has to start before
 * anything it instruments has been imported, which is before Nest exists, so it
 * lives in `instrumentation.ts` and is preloaded with `node --import`.
 */

export interface ObservabilityModuleOptions {
  /** The logger boot built. A failed sample is a warning on it. */
  readonly logger: Logger;
  /** What boot learned: the verified runtime role and the migration count. */
  readonly bootFacts: BootFacts;
}

/**
 * Fills the gauges nobody pushes, every 15 s. A provider rather than a loose
 * `setInterval`, so Nest starts it once the app is built and stops it on
 * `app.close()` in the same order as everything else.
 */
@Injectable()
export class ObservabilityGauges implements OnModuleInit, OnApplicationShutdown {
  readonly #sampler: MetricsSampler;
  readonly #queues: QueueRegistry;
  /** The cycle already added to the histogram, so one cycle is counted once. */
  #lastRelayCycleAt: string | null = null;

  constructor(
    @Inject(METRICS) metrics: Metrics,
    @Inject(QUEUE_REGISTRY) queues: QueueRegistry,
    @Inject(DB) db: Db,
    @Inject(REDIS) redis: Redis,
    @Inject(ReadinessService) readiness: ReadinessService,
    @Inject(OBSERVABILITY_LOGGER) log: Logger,
  ) {
    this.#queues = queues;
    this.#sampler = new MetricsSampler({
      log,
      sample: async () => {
        const [counts, checks, relay, postgres] = await Promise.all([
          queues.counts(),
          readiness.detail(),
          readRelayStatus(redis).catch(() => null),
          readPostgresFacts(db),
        ]);

        recordQueueCounts(metrics, counts);
        recordDependency(metrics, {
          database: checkReached(checks, 'database'),
          redis: checkReached(checks, 'redis'),
        });
        recordPoolConnections(metrics, postgres.connections);
        this.#lastRelayCycleAt = recordRelayStatus(metrics, relay, this.#lastRelayCycleAt);
      },
    });
  }

  onModuleInit(): void {
    this.#sampler.start();
  }

  /**
   * One pass, now. The timer is the production path; this is how an integration
   * test proves the gauges carry real readings rather than waiting 15 seconds
   * for the loop to come round.
   */
  async sampleOnce(): Promise<void> {
    await this.#sampler.sampleOnce();
  }

  async onApplicationShutdown(): Promise<void> {
    this.#sampler.stop();
    await this.#queues.close();
  }
}

/**
 * Global because a metrics registry is process state, like the database pool
 * and the Redis client: whichever module holds the thing worth counting writes
 * to the same one. `RealtimeModule` sets `socket_connections` that way.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class ObservabilityModule {
  static forRoot({ logger, bootFacts }: ObservabilityModuleOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: [MetricsController, SystemController],
      providers: [
        { provide: OBSERVABILITY_LOGGER, useValue: logger },
        { provide: BOOT_FACTS, useValue: bootFacts },
        { provide: METRICS, useFactory: createMetrics },
        {
          provide: QUEUE_REGISTRY,
          inject: [ENV],
          useFactory: (env: Env) => new QueueRegistry(env.REDIS_URL),
        },
        ReadinessService,
        SystemService,
        ObservabilityGauges,
      ],
      // `ReadinessService` is owned here because `/ready` is observability, and
      // exported because `HealthController` — which answers it — belongs to the
      // app's own route table.
      exports: [METRICS, ReadinessService],
    };
  }
}
