import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/**
 * A real Helpdock install, started for the `api` Playwright project: Postgres
 * and Redis in containers, the api built and run as its own process, and one
 * seeded account with a password and an authenticator secret the test knows.
 *
 * The api is **spawned**, not imported. `apps/*` never import each other
 * (ARCHITECTURE §2, `pnpm check:boundaries`), and a browser test is no
 * exception: it reaches the api the way a browser does, over HTTP. What it
 * reaches into is the build output, which is why `pnpm build` has to have run.
 *
 * The ports are fixed rather than picked at random because the Vite dev server
 * has to be told where to proxy `/api` before any of this starts. Both can be
 * moved with an environment variable if something else is already listening.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 5).toString('base64');

/** Deliberately not 3000 or 5273: a local `pnpm dev` may be on both. */
export const E2E_API_PORT = Number(process.env.HD_E2E_API_PORT ?? 3099);
export const E2E_WEB_PORT = Number(process.env.HD_E2E_WEB_PORT ?? 5274);
export const E2E_API_ORIGIN = `http://localhost:${String(E2E_API_PORT)}`;
export const E2E_WEB_ORIGIN = `http://localhost:${String(E2E_WEB_PORT)}`;

/** How the seeded account reaches the spec, which runs in another process. */
export const TOTP_SECRET_ENV = 'HD_E2E_TOTP_SECRET';
export const ACCOUNT_EMAIL_ENV = 'HD_E2E_EMAIL';
export const ACCOUNT_PASSWORD_ENV = 'HD_E2E_PASSWORD';
/** Set when Docker is missing, so the specs skip with a reason instead of failing. */
export const SKIP_ENV = 'HD_E2E_API_UNAVAILABLE';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '../../../api');

export interface RunningInstall {
  stop(): Promise<void>;
}

export const dockerIsAvailable = (): Promise<boolean> =>
  promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 10_000,
  }).then(
    () => true,
    () => false,
  );

const run = (script: string, env: NodeJS.ProcessEnv, args: string[] = []): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: apiRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`${script} exited with ${String(code)}:\n${err || out}`));
      }
    });
  });

const waitForHealth = async (origin: string, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`the api never became healthy on ${origin}`);
};

export const startInstall = async (): Promise<RunningInstall> => {
  const entry = path.join(apiRoot, 'dist/main.js');
  if (!existsSync(entry)) {
    throw new Error(
      'apps/api is not built. Run `pnpm build` before `pnpm --filter @helpdock/admin e2e:api`.',
    );
  }

  const [postgres, redis] = (await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
  ])) as [StartedPostgreSqlContainer, StartedRedisContainer];

  const env: NodeJS.ProcessEnv = {
    // The browser talks to Vite, which proxies `/api` here, so as far as the
    // cookie is concerned there is one origin. `APP_URL` is the web origin
    // because that is where the api redirects a magic link back to.
    APP_URL: E2E_WEB_ORIGIN,
    APP_ROLE: 'api',
    APP_MASTER_KEY: MASTER_KEY,
    NODE_ENV: 'test',
    PORT: String(E2E_API_PORT),
    DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${String(postgres.getPort())}/${postgres.getDatabase()}`,
    DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'helpdock',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  const seeded = JSON.parse(
    await run(path.join(apiRoot, 'dist/seed/seed-dev.js'), env, ['--with-totp', '--json']),
  ) as { email: string; password: string; totpSecret: string };

  const api = spawn(process.execPath, [entry], {
    cwd: apiRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    await waitForHealth(E2E_API_ORIGIN);
  } catch (error) {
    api.kill('SIGKILL');
    await Promise.all([postgres.stop(), redis.stop()]);
    throw error;
  }

  // Playwright hands the workers this process's environment, which is how a
  // secret drawn at seed time reaches a spec in another process.
  process.env[ACCOUNT_EMAIL_ENV] = seeded.email;
  process.env[ACCOUNT_PASSWORD_ENV] = seeded.password;
  process.env[TOTP_SECRET_ENV] = seeded.totpSecret;

  return {
    stop: async () => {
      api.kill('SIGTERM');
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
};
