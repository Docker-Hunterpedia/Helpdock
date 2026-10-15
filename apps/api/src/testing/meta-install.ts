import type { Env } from '@helpdock/config';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { dockerAvailable } from './docker-available.js';

/**
 * What every Meta integration suite begins with, written once: whether Docker is
 * there, the Postgres and Redis containers, and the `Env` of an api that talks to
 * a stand-in for Graph. Seven suites each carried a copy of it, and each paid for
 * its own pair of containers in the api's CI shards; the suites still start their
 * own, because they share no rows, but they no longer spell the setup out.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
/** A cold image pull on a loaded runner is slow; a suite's `beforeAll` allows the same. */
const CONTAINER_STARTUP_MS = 120_000;
const APP_ROLE_PASSWORD = 'app-role-password';

/** Local absence may skip a suite; CI must run the required database tests. */
export const hasDocker = await dockerAvailable();

export const startPostgres = (): Promise<StartedPostgreSqlContainer> =>
  new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start();

export const startRedis = (): Promise<StartedRedisContainer> =>
  new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start();

/** The stand-in's two roots, which `META_GRAPH_API_ROOT` and `META_INSTAGRAM_API_ROOT` name. */
export interface GraphRoots {
  readonly facebookRoot: string;
  readonly instagramRoot: string;
}

/**
 * The api's environment for a suite: the app role on the container's database,
 * the container's Redis, loopback allowed for the SSRF-safe client (it is how
 * the stand-in is reached) and Graph pointed at the stand-in.
 */
export const metaEnv = ({
  masterKey,
  postgres,
  redis,
  graph,
}: {
  readonly masterKey: string;
  readonly postgres: StartedPostgreSqlContainer;
  readonly redis: StartedRedisContainer;
  readonly graph: GraphRoots;
}): Env =>
  ({
    APP_URL: 'https://support.example.com',
    APP_ROLE: 'api',
    APP_MASTER_KEY: masterKey,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: 0,
    TRUST_PROXY: false,
    DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
    DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'helpdock',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret',
    S3_FORCE_PATH_STYLE: true,
    FFMPEG_PATH: 'ffmpeg',
    FFPROBE_PATH: 'ffprobe',
    CLAMAV_PORT: 3310,
    ADMIN_DIST_DIR: '/nonexistent',
    OUTBOUND_ALLOW_CIDRS: ['127.0.0.0/8'],
    META_GRAPH_API_ROOT: graph.facebookRoot,
    META_INSTAGRAM_API_ROOT: graph.instagramRoot,
  }) as Env;
