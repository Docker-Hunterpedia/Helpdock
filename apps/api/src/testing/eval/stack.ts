import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HttpTransport } from '@helpdock/ai';
import type { Env } from '@helpdock/config';
import { createDb } from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { seedDevInstall } from '../../seed/dev-seed.js';
import { FakeStorage } from '../media.js';
import { signInForTest } from '../staff-sign-in.js';

/**
 * The install an evaluation run works in (M7-11): Postgres with pgvector and
 * Redis in containers — or the throwaway pair `AI_EVAL_DATABASE_URL` and
 * `AI_EVAL_REDIS_URL` name — migrated, the dev install seeded, and the api
 * in process so the fixture can be loaded through the same routes an admin
 * uses. The bucket is a temporary directory: the one upload is the fixture
 * PDF.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const CONTAINER_STARTUP_MS = 180_000;
const APP_ROLE_PASSWORD = 'ai-eval-app-role';
const MASTER_KEY = Buffer.alloc(32, 71).toString('base64');

export const hasDocker = await promisify(execFile)(
  'docker',
  ['info', '--format', '{{.ServerVersion}}'],
  { timeout: 10_000 },
).then(
  () => true,
  () => false,
);

export interface StaffResponse<T> {
  readonly status: number;
  readonly body: T;
}

export interface EvalStack {
  readonly runtime: Runtime;
  readonly app: ApiApp;
  readonly storage: FakeStorage;
  readonly brandId: string;
  /** A request as the seeded admin, the way the integration suites make them. */
  staff<T>(
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
  ): Promise<StaffResponse<T>>;
  stop(): Promise<void>;
}

export interface EvalStackOptions {
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
  /** The embeddings endpoint and model discovery; fake in mock mode. */
  readonly http: HttpTransport;
}

const appUrlOf = (ownerUrl: string): string => {
  const url = new URL(ownerUrl);
  url.username = 'helpdock_app';
  url.password = APP_ROLE_PASSWORD;
  return url.href;
};

const envFor = (migrationUrl: string, redisUrl: string): Env =>
  ({
    APP_URL: 'https://support.example.com',
    APP_ROLE: 'api',
    APP_MASTER_KEY: MASTER_KEY,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: 0,
    TRUST_PROXY: false,
    DATABASE_URL: appUrlOf(migrationUrl),
    DATABASE_MIGRATION_URL: migrationUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'helpdock',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_FORCE_PATH_STYLE: true,
    FFMPEG_PATH: 'ffmpeg',
    FFPROBE_PATH: 'ffprobe',
    CLAMAV_PORT: 3310,
    ADMIN_DIST_DIR: 'apps/admin/dist',
    OUTBOUND_ALLOW_CIDRS: [],
  }) as Env;

export const startEvalStack = async (options: EvalStackOptions): Promise<EvalStack> => {
  const closers: (() => Promise<unknown>)[] = [];
  let migrationUrl: string;
  let redisUrl: string;

  if (options.databaseUrl !== undefined && options.redisUrl !== undefined) {
    migrationUrl = options.databaseUrl;
    redisUrl = options.redisUrl;
  } else {
    const [postgres, redis]: [StartedPostgreSqlContainer, StartedRedisContainer] =
      await Promise.all([
        new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
        new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      ]);
    closers.push(() => Promise.all([postgres.stop(), redis.stop()]));
    const bootstrap = createDb({ url: postgres.getConnectionUri(), max: 1 });
    await bootstrap.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await bootstrap.close();
    migrationUrl = `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${String(postgres.getPort())}/helpdock`;
    redisUrl = redis.getConnectionUrl();
  }

  const env = envFor(migrationUrl, redisUrl);
  const bucket = await mkdtemp(path.join(tmpdir(), 'helpdock-ai-eval-'));
  closers.unshift(() => rm(bucket, { recursive: true, force: true }));
  const storage = new FakeStorage(bucket);
  const runtime = await createRuntime({
    env,
    logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
  });
  closers.unshift(() => runtime.close());
  const app = await createApiApp({ runtime, objectStorage: storage, ai: { http: options.http } });
  closers.unshift(() => app.close());
  const seeded = await seedDevInstall({ db: runtime.db, env });
  const adminToken = await signInForTest(app, { email: seeded.email, password: seeded.password });

  return {
    runtime,
    app,
    storage,
    brandId: seeded.brandId,
    staff: async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
      const response = await app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${adminToken}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
      return {
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      };
    },
    stop: async () => {
      for (const close of closers) {
        await close();
      }
    },
  };
};
