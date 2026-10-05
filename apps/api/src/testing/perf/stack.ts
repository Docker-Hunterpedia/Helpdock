import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeMasterKey } from '@helpdock/config';
import { createDb, type DbHandle, runMigrations } from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { sql } from 'drizzle-orm';
import { PasswordHasher } from '../../auth/password.js';

/**
 * What every performance suite (M1-15, M9-03) runs against: a fresh Postgres
 * and Redis in containers, migrated, seeded, and the api started from `dist/`
 * as separate processes — DOMAIN-RULES §14's "2 `api` replicas" and, when a
 * suite needs side effects delivered, its "1 `worker`".
 *
 * The seed runs as the runtime role, so every row passes the same policies and
 * triggers the api's writes do; the statistics are then gathered as the owner,
 * which the runtime role deliberately is not.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'perf-app-role-password';
const MASTER_KEY = Buffer.alloc(32, 14).toString('base64');
const API_ROOT = path.resolve(import.meta.dirname, '../../..');
const API_ENTRY = path.join(API_ROOT, 'dist/main.js');
const BASE_PORT = 3900;

/** The password every seeded account signs in with. */
export const PERF_PASSWORD = 'a perf run password';

/** A non-negative number from the environment, or the fallback. */
export const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
};

export const hasDocker = await promisify(execFile)(
  'docker',
  ['info', '--format', '{{.ServerVersion}}'],
  { timeout: 10_000 },
).then(
  () => true,
  () => false,
);

export interface PerfStackOptions {
  /** Api processes, each on its own port. */
  readonly replicas: number;
  /** Also start one `APP_ROLE=worker` process, for suites that need the outbox delivered. */
  readonly worker?: boolean;
  /** Extra environment for every process, for example `TRUST_PROXY`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Writes the suite's rows, as the runtime role, before any process starts. */
  readonly seed: (app: DbHandle, passwordHash: string) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface PerfStack {
  /** One per api replica. */
  readonly baseUrls: readonly string[];
  /** The runtime role, which row-level security applies to. */
  readonly app: DbHandle;
  /** The migration owner, for `ANALYZE` and the occasional fixture only it may write. */
  readonly owner: DbHandle;
  stop(): Promise<void>;
}

export const startPerfStack = async (options: PerfStackOptions): Promise<PerfStack> => {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  if (!existsSync(API_ENTRY)) {
    throw new Error(`${API_ENTRY} is missing: run \`pnpm --filter @helpdock/api build\` first`);
  }

  const [postgres, redis]: [StartedPostgreSqlContainer, StartedRedisContainer] = await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(120_000).start(),
    new RedisContainer(REDIS_IMAGE).withStartupTimeout(120_000).start(),
  ]);

  const bootstrap = createDb({ url: postgres.getConnectionUri(), max: 1 });
  await bootstrap.db.execute(sql.raw('CREATE DATABASE helpdock'));
  await bootstrap.close();

  const hostPort = `${postgres.getHost()}:${postgres.getPort()}`;
  const migrationUrl = `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${hostPort}/helpdock`;
  const appUrl = `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${hostPort}/helpdock`;

  await runMigrations({ migrationUrl, appRolePassword: APP_ROLE_PASSWORD, log: () => {} });
  const owner = createDb({ url: migrationUrl, max: 2 });
  const app = createDb({ url: appUrl, max: 2 });

  const masterKey = decodeMasterKey(MASTER_KEY);
  if (masterKey === undefined) {
    throw new Error('the perf master key is not 32 bytes of base64');
  }

  const seedStarted = performance.now();
  await options.seed(app, await new PasswordHasher(masterKey).hash(PERF_PASSWORD));
  await owner.db.execute(sql`ANALYZE`);
  log(`Seeded in ${Math.round((performance.now() - seedStarted) / 1000)} s.`);

  const processEnv = (port: number, role: 'api' | 'worker') => ({
    ...process.env,
    APP_URL: `http://127.0.0.1:${port}`,
    APP_ROLE: role,
    APP_MASTER_KEY: MASTER_KEY,
    NODE_ENV: 'production',
    LOG_LEVEL: 'warn',
    PORT: String(port),
    DATABASE_URL: appUrl,
    DATABASE_MIGRATION_URL: migrationUrl,
    REDIS_URL: redis.getConnectionUrl(),
    S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'helpdock',
    S3_ACCESS_KEY_ID: 'perf',
    S3_SECRET_ACCESS_KEY: 'perf',
    ...options.env,
  });
  const start = (port: number, role: 'api' | 'worker'): ChildProcess =>
    spawn(process.execPath, [API_ENTRY], {
      cwd: API_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: processEnv(port, role),
    });

  const processes: ChildProcess[] = [];
  const baseUrls: string[] = [];
  for (let index = 0; index < Math.max(1, options.replicas); index += 1) {
    const port = BASE_PORT + index;
    processes.push(start(port, 'api'));
    baseUrls.push(`http://127.0.0.1:${port}`);
  }
  for (const baseUrl of baseUrls) {
    await waitForHealth(baseUrl);
  }
  if (options.worker === true) {
    processes.push(start(BASE_PORT + baseUrls.length, 'worker'));
  }

  return {
    baseUrls,
    app,
    owner,
    stop: async () => {
      for (const child of processes) {
        child.kill('SIGTERM');
      }
      await app.close();
      await owner.close();
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
};

const waitForHealth = async (baseUrl: string): Promise<void> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const healthy = await fetch(`${baseUrl}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${baseUrl} did not become healthy`);
};

/** A password sign-in; the access token is good on every replica. */
export const signIn = async (baseUrl: string, email: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/api/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PERF_PASSWORD }),
  });
  const body = (await response.json()) as { kind?: string; accessToken?: string };
  if (body.kind !== 'session' || body.accessToken === undefined) {
    throw new Error(`sign-in as ${email} did not produce a session`);
  }
  return body.accessToken;
};
