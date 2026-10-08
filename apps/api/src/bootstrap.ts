import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import {
  createKeyring,
  createSettings,
  type Env,
  RedisInvalidation,
  type Settings,
} from '@helpdock/config';
import {
  appRolePasswordFromUrl,
  assertRuntimeRoleIsSafe,
  createDb,
  type Db,
  PostgresSettingsStore,
  runMigrations,
} from '@helpdock/db';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { ApiKeyPrincipalResolver } from './api-keys/api-key-principal-resolver.js';
import { ApiKeysRepository } from './api-keys/api-keys.repository.js';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { createPrincipalResolver } from './auth/principal-resolver.js';
import { RateLimiter } from './auth/rate-limit.js';
import { RefreshStore } from './auth/session/refresh-store.js';
import { SessionPrincipalResolver } from './auth/session/session-principal-resolver.js';
import { loadOrCreateSigningKeys, type SigningKeys } from './auth/session/signing-keys.js';
import { INBOUND_PARSE_ROUTE, registerFormBodies } from './channels/inbound/inbound-parse-body.js';
import { registerClientFacts } from './context/client-facts.js';
import { registerJsonDisposition } from './http/json-disposition.js';
import { registerPermissionsPolicy, securityHeaderOptions } from './http/security-headers.js';
import { createLogger, type Logger, NestPinoLogger } from './logging/logger.js';
import type { BootFacts } from './observability/boot-facts.js';
import { registerHttpMetrics } from './observability/http-metrics.js';
import type { Metrics } from './observability/metrics.js';
import { QueueBoardAccess, registerQueueBoard } from './observability/queue-board.js';
import type { QueueRegistry } from './observability/queues.js';
import { countRateLimitRefusalsIn } from './observability/rate-limit-refusals.js';
import { METRICS, QUEUE_REGISTRY } from './observability/tokens.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';
import { waitForMigrations } from './runtime/wait-for-migrations.js';
import { resolveAdminDist } from './static/admin-assets.js';
import { WEB_FORM_ROUTE } from './web-form/web-form-page.controller.js';
import { registerWidgetCors } from './widget/widget-cors.js';
import { startWorker } from './worker/start-worker.js';

/**
 * Boot, in the order ARCHITECTURE §6 and DOMAIN-RULES §1.5 require:
 *
 * 1. `loadEnv()` — done by the caller, because nothing below can run without it.
 * 2. `APP_ROLE=api` only: run the migrations as the owner role, under the
 *    advisory lock, so several replicas starting together migrate once.
 * 3. Open the runtime pool.
 * 4. `APP_ROLE=worker` only: wait for an api replica to have migrated.
 * 5. `assertRuntimeRoleIsSafe` — refuse to serve if this connection could
 *    bypass row-level security.
 * 6. Settings, over the `settings` table with Redis invalidation.
 * 7. Listen, for `APP_ROLE=api`.
 */

export interface Runtime {
  readonly env: Env;
  readonly db: Db;
  readonly redis: Redis;
  readonly settings: Settings;
  readonly logger: Logger;
  /** Generated on the first boot of an install and shared by every replica (M0-05). */
  readonly signingKeys: SigningKeys;
  /**
   * What boot learned and the request path cannot ask for again: the role check
   * that decided whether this process may serve at all (DOMAIN-RULES §1.5), and
   * the migration count, which only the owner connection may read.
   */
  readonly bootFacts: BootFacts;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  readonly env: Env;
  /** Overrides the logger boot would build. Tests pass a silent one. */
  readonly logger?: Logger;
}

export const createRuntime = async ({
  env,
  logger = createLogger({ env }),
}: CreateRuntimeOptions): Promise<Runtime> => {
  // A worker never migrates, so it never learns the count: the migration log
  // lives in the `drizzle` schema, which the runtime role deliberately cannot
  // read (DOMAIN-RULES §1.5). The System page is served by an api replica,
  // which does.
  let migrationsApplied: number | null = null;
  let migrations: readonly string[] | null = null;

  if (env.APP_ROLE === 'api') {
    const result = await runMigrations({
      migrationUrl: env.DATABASE_MIGRATION_URL,
      appRolePassword: appRolePasswordFromUrl(env.DATABASE_URL),
      log: (message) => logger.info(message),
    });
    migrationsApplied = result.total;
    migrations = result.recorded;
  }

  const { db, close: closeDb } = createDb({ url: env.DATABASE_URL });
  const closers: (() => Promise<unknown>)[] = [closeDb];

  try {
    if (env.APP_ROLE === 'worker') {
      await waitForMigrations({ db, logger });
    }

    const facts = await assertRuntimeRoleIsSafe(db);
    logger.info(
      {
        // Not `role`: every line already carries `role: APP_ROLE`, and a
        // repeated key is a line only the last writer wins in.
        databaseRole: facts.roleName,
        superuser: facts.superuser,
        bypassRls: facts.bypassRls,
        ownedTables: facts.ownedTables,
      },
      'Runtime database role verified; row-level security cannot be bypassed.',
    );

    const invalidation = await RedisInvalidation.connect({
      url: env.REDIS_URL,
      onError: (error) => logger.error({ err: error }, 'Redis invalidation channel error'),
    });
    closers.unshift(() => invalidation.close());

    const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
    redis.on('error', (error: Error) => logger.error({ err: error }, 'Redis client error'));
    await redis.connect();
    closers.unshift(() => redis.quit());

    const settings = createSettings({
      env: process.env,
      store: new PostgresSettingsStore({ db }),
      keyring: createKeyring(env),
      invalidation,
    });
    closers.unshift(() => settings.close());

    // After settings, because the key pair is stored there, and before the app,
    // because nothing can verify a token without it (ARCHITECTURE §7).
    const signingKeys = await loadOrCreateSigningKeys({ settings, redis, logger });

    return {
      env,
      db,
      redis,
      settings,
      logger,
      signingKeys,
      bootFacts: { runtimeRole: facts, migrationsApplied, migrations },
      close: async () => {
        for (const close of closers) {
          await close();
        }
      },
    };
  } catch (error) {
    // Everything opened so far has to be given back, or a failed boot leaves
    // connections behind and the next restart finds fewer of them. A failure to
    // close is logged and then dropped: the error that stopped the boot is the
    // one the operator has to read, and it must not be replaced by the
    // consequences of it.
    for (const close of closers) {
      await close().catch((closeError: unknown) => {
        logger.warn(
          { err: closeError },
          'Failed to close a resource while unwinding a failed boot',
        );
      });
    }
    throw error;
  }
};

export type ApiApp = NestFastifyApplication;

export interface CreateApiAppOptions {
  readonly runtime: Runtime;
  readonly extraControllers?: AppModuleOptions['extraControllers'];
  readonly brandResolver?: AppModuleOptions['brandResolver'];
  /** M1-10's bucket. Boot leaves it out and the module builds one from `S3_*`. */
  readonly objectStorage?: AppModuleOptions['objectStorage'];
  /** M2's IMAP connection and image fetcher, for suites. */
  readonly channels?: AppModuleOptions['channels'];
  /** M6's Bot API, for suites. */
  readonly telegram?: AppModuleOptions['telegram'];
  /** M4's siteverify call and SSE timings, for suites. */
  readonly widget?: AppModuleOptions['widget'];
  /** M4-09's siteverify call, for suites. */
  readonly webForm?: AppModuleOptions['webForm'];
  /** M7's model discovery HTTP, for suites. */
  readonly ai?: AppModuleOptions['ai'];
  /** M7-05's retrieval HTTP and model, for suites. */
  readonly assist?: AppModuleOptions['assist'];
  /** M7-03's Notion and Google Drive APIs, for suites. */
  readonly knowledge?: AppModuleOptions['knowledge'];
}

export const createApiApp = async ({
  runtime,
  extraControllers,
  brandResolver,
  objectStorage,
  channels,
  telegram,
  widget,
  webForm,
  ai,
  assist,
  knowledge,
}: CreateApiAppOptions): Promise<ApiApp> => {
  const { env, logger } = runtime;

  // One of each, shared by the HTTP guards and the socket handshake: a socket
  // "authenticates on handshake exactly like HTTP" (DOMAIN-RULES §1.4), and two
  // resolvers would be two places for that to stop being true.
  const refreshStore = new RefreshStore(runtime.redis);
  const sessionResolver = new SessionPrincipalResolver({
    keys: runtime.signingKeys,
    refresh: refreshStore,
    logger,
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({
      env,
      db: runtime.db,
      settings: runtime.settings,
      redis: runtime.redis,
      logger,
      bootFacts: runtime.bootFacts,
      auth: { signingKeys: runtime.signingKeys, logger },
      realtime: { sessionResolver, revocations: refreshStore },
      // M8-01: `hd_live_…` bearers are API keys; anything else is the session's.
      principalResolver: new ApiKeyPrincipalResolver({
        db: runtime.db,
        keys: new ApiKeysRepository(),
        limiter: new RateLimiter(runtime.redis),
        fallback: createPrincipalResolver({ env, logger, session: sessionResolver }),
      }),
      ...(brandResolver === undefined ? {} : { brandResolver }),
      ...(objectStorage === undefined ? {} : { objectStorage }),
      ...(channels === undefined ? {} : { channels }),
      ...(telegram === undefined ? {} : { telegram }),
      ...(widget === undefined ? {} : { widget }),
      ...(webForm === undefined ? {} : { webForm }),
      ...(ai === undefined ? {} : { ai }),
      ...(assist === undefined ? {} : { assist }),
      ...(knowledge === undefined ? {} : { knowledge }),
      ...(extraControllers === undefined ? {} : { extraControllers }),
    }),
    // `trustProxy` decides what `request.ip` and `x-forwarded-*` mean. It is the
    // same promise `TRUST_PROXY` makes about `x-request-id`, so it is the same
    // switch (REQUIREMENTS §5.1).
    new FastifyAdapter({ trustProxy: env.TRUST_PROXY }),
    // `abortOnError: false` so a boot failure is thrown rather than turned into
    // `process.abort()`. Aborting leaves a container with SIGABRT and a core
    // dump where `main.ts` would have written the message that says what to fix.
    { logger: new NestPinoLogger(logger), bufferLogs: false, abortOnError: false },
  );

  // Before helmet only because order does not matter here; both are plugins the
  // auth routes need before anything is served. The cookie plugin carries no
  // secret: the one cookie that is signed is signed with a key derived from
  // `APP_MASTER_KEY` in `auth/totp/trusted-device.ts`, so that the signing key
  // is the same on every replica without a second thing to configure.
  await app.register(cookie);
  await app.register(helmet, securityHeaderOptions({ appUrl: env.APP_URL }));
  registerPermissionsPolicy(app.getHttpAdapter().getInstance());
  // M4-03. After helmet, so the widget routes' cross-origin headers win.
  registerWidgetCors(app.getHttpAdapter().getInstance());

  // Before `init()`, which is when Nest binds gateways to whatever adapter is
  // installed. After it, the gateway would have been bound to Nest's default
  // one: no Redis, both transports, and no origin check (M0-13).
  const websockets = new RedisIoAdapter(app, { appUrl: env.APP_URL, logger });
  await websockets.connect(env.REDIS_URL);
  app.useWebSocketAdapter(websockets);

  // `serve: false` registers no routes of its own: it only decorates
  // `reply.sendFile`, so `AdminSpaController` stays the single place that
  // decides what a path means and which cache headers it earns.
  const adminDist = resolveAdminDist(env.ADMIN_DIST_DIR);
  if (adminDist === undefined) {
    logger.warn(
      { adminDistDir: env.ADMIN_DIST_DIR },
      'No admin build found; the api will serve /api only (ADMIN_DIST_DIR)',
    );
  } else {
    await app.register(fastifyStatic, { root: adminDist, serve: false });
  }

  // Before `init()`, because Fastify refuses a hook added after the instance is
  // ready, and on the Fastify instance rather than as a Nest interceptor so
  // that 401s, 403s and 404s are counted too (see `http-metrics.ts`).
  registerHttpMetrics(app.getHttpAdapter().getInstance(), app.get<Metrics>(METRICS));
  registerClientFacts(app.getHttpAdapter().getInstance());
  countRateLimitRefusalsIn(app.get<Metrics>(METRICS).rateLimitRefusals);
  registerJsonDisposition(app.getHttpAdapter().getInstance());

  // M2-03 and M4-09. Before `init()`, which is when Nest adds its routes: the
  // `onRoute` hook that raises their body limit only sees routes added after it.
  registerFormBodies(app.getHttpAdapter().getInstance(), [INBOUND_PARSE_ROUTE, WEB_FORM_ROUTE]);

  // M8-05: Bull Board brings its own router, so it is a Fastify plugin behind
  // its own install-admin session check (`queue-board.ts`, ADR 0017).
  await registerQueueBoard(app.getHttpAdapter().getInstance(), {
    access: app.get(QueueBoardAccess),
    queues: app.get<QueueRegistry>(QUEUE_REGISTRY).queues(),
    secure: new URL(env.APP_URL).protocol === 'https:',
  });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return app;
};

/**
 * The entry point's body, kept here so `main.ts` stays a single call and so a
 * test can start the same process shape without spawning one.
 */
export const start = async (env: Env): Promise<{ close: () => Promise<void> }> => {
  const runtime = await createRuntime({ env });

  if (env.APP_ROLE === 'worker') {
    const worker = startWorker({
      env,
      db: runtime.db,
      log: runtime.logger,
      settings: runtime.settings,
    });
    runtime.logger.info('Worker ready: outbox relay running and outbox.event consumed.');

    return {
      close: async () => {
        await worker.close();
        await runtime.close();
      },
    };
  }

  const app = await createApiApp({ runtime });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  runtime.logger.info({ port: env.PORT }, 'api listening');

  return {
    close: async () => {
      await app.close();
      await runtime.close();
    },
  };
};
