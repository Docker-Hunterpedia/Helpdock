import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import {
  E2E_GRAPH_ROOT,
  E2E_INSTAGRAM_ROOT,
  E2E_META_APP_ID,
  startFakeGraph,
} from './fake-graph.js';
import { fakeOidcIdp } from './fake-oidc.js';
import { fakeSamlIdp } from './fake-saml.js';
import { E2E_TELEGRAM_ROOT, startFakeTelegram } from './fake-telegram.js';

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

/**
 * The second install, the one nobody has set up yet (M0-08). It is a separate
 * database and a separate api process rather than a reset of the first,
 * because "fresh" means the `users` table is empty, and the seeded account the
 * sign-in specs need makes that impossible to share.
 *
 * It has no Vite in front of it: this process serves `apps/admin/dist` itself,
 * which is the production topology (ARCHITECTURE §3) and the only way the
 * wizard can be tested at all — the install state reaches the app as a meta tag
 * the api rewrites into `index.html`, and a dev server serves its own copy of
 * that file with the development fixture in it.
 */
export const E2E_SETUP_API_PORT = Number(process.env.HD_E2E_SETUP_API_PORT ?? 3098);
export const E2E_SETUP_ORIGIN = `http://localhost:${String(E2E_SETUP_API_PORT)}`;
const SETUP_DATABASE = 'helpdock_setup';
/**
 * The second install sets `HD_SETUP_TOKEN` (#43), so the wizard spec proves the
 * key end to end: the meta tag that draws the field, and the api that checks it.
 */
export const E2E_SETUP_KEY = 'e2e-setup-key-that-is-at-least-32-chars';

/** How the seeded account reaches the spec, which runs in another process. */
export const TOTP_SECRET_ENV = 'HD_E2E_TOTP_SECRET';
export const ACCOUNT_EMAIL_ENV = 'HD_E2E_EMAIL';
export const ACCOUNT_PASSWORD_ENV = 'HD_E2E_PASSWORD';
/** A live invitation the staff spec accepts. Seeded, because nothing logs a link. */
export const INVITE_TOKEN_ENV = 'HD_E2E_INVITE_TOKEN';
export const INVITEE_EMAIL = 'invitee@helpdock.test';
/** Set when Docker is missing, so the specs skip with a reason instead of failing. */
export const SAML_CONNECTION_ENV = 'HD_E2E_SAML_CONNECTION';
export const OIDC_CONTROL_KEY_ENV = 'HD_E2E_OIDC_CONTROL_KEY';
export const SAML_CONTROL_KEY_ENV = 'HD_E2E_SAML_CONTROL_KEY';
export const SAML_CERTIFICATE_ENV = 'HD_E2E_SAML_CERTIFICATE';
export const SSO_CONNECTION_ENV = 'HD_E2E_SSO_CONNECTION_ID';
export const SKIP_ENV = 'HD_E2E_API_UNAVAILABLE';
export const REDIS_CONTAINER_ENV = 'HD_E2E_REDIS_CONTAINER';
/**
 * The seeded api's environment, as JSON, so a spec can start a replica of it
 * against the same Postgres and Redis ({@link startApiReplica}).
 */
const API_ENV_ENV = 'HD_E2E_API_ENV';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '../../../api');
const adminDist = path.resolve(here, '../../dist');
/** The widget build the seeded api serves at `/widget.js` (M4-01), for the live widget spec. */
const widgetDist = path.resolve(here, '../../../widget/dist');

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
  if (
    !existsSync(entry) ||
    !existsSync(path.join(adminDist, 'index.html')) ||
    !existsSync(path.join(widgetDist, 'widget.js'))
  ) {
    throw new Error(
      'apps/api, apps/admin or apps/widget is not built. Run `pnpm build` before `pnpm --filter @helpdock/admin e2e:api`.',
    );
  }

  const [postgres, redis, telegram, graph, oidc, saml] = (await Promise.all([
    new PostgreSqlContainer(POSTGRES_IMAGE).start(),
    new RedisContainer(REDIS_IMAGE).start(),
    startFakeTelegram(),
    startFakeGraph(),
    fakeOidcIdp(),
    fakeSamlIdp(),
  ])) as [
    StartedPostgreSqlContainer,
    StartedRedisContainer,
    Awaited<ReturnType<typeof startFakeTelegram>>,
    Awaited<ReturnType<typeof startFakeGraph>>,
    Awaited<ReturnType<typeof fakeOidcIdp>>,
    Awaited<ReturnType<typeof fakeSamlIdp>>,
  ];

  const host = postgres.getHost();
  const port = String(postgres.getPort());
  const owner = `${postgres.getUsername()}:${postgres.getPassword()}`;

  const envFor = ({
    appUrl,
    apiPort,
    database,
    redisDb,
    servesAdmin = false,
    setupKey,
  }: {
    appUrl: string;
    apiPort: number;
    database: string;
    redisDb: number;
    servesAdmin?: boolean;
    setupKey?: string;
  }): NodeJS.ProcessEnv => ({
    // The browser talks to Vite, which proxies `/api` here, so as far as the
    // cookie is concerned there is one origin. `APP_URL` is the web origin
    // because that is where the api redirects a magic link back to.
    APP_URL: appUrl,
    APP_ROLE: 'api',
    APP_MASTER_KEY: MASTER_KEY,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${host}:${port}/${database}`,
    DATABASE_MIGRATION_URL: `postgres://${owner}@${host}:${port}/${database}`,
    // A database of its own, so the two installs cannot see each other's
    // sessions, rate-limit counters or signing key.
    REDIS_URL: `${redis.getConnectionUrl()}/${String(redisDb)}`,
    S3_ENDPOINT: 'http://minio:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'helpdock',
    S3_ACCESS_KEY_ID: 'access',
    S3_SECRET_ACCESS_KEY: 'secret',
    ...(servesAdmin ? { ADMIN_DIST_DIR: adminDist } : {}),
    WIDGET_DIST_DIR: widgetDist,
    // Channels › Telegram talks to a local stand-in rather than Telegram (M6-05).
    TELEGRAM_API_ROOT: E2E_TELEGRAM_ROOT,
    // Channels › Meta talks to a local stand-in for Graph (M10-07), which the
    // SSRF-safe client reaches because loopback is allowed. The install's Meta
    // app is set by the environment, which is also what the App card says.
    META_GRAPH_API_ROOT: E2E_GRAPH_ROOT,
    META_INSTAGRAM_API_ROOT: E2E_INSTAGRAM_ROOT,
    OUTBOUND_ALLOW_CIDRS: '127.0.0.0/8',
    HD_META_APP_ID: E2E_META_APP_ID,
    HD_META_APP_SECRET: 'e2e-meta-app-secret',
    ...(setupKey === undefined ? {} : { HD_SETUP_TOKEN: setupKey }),
  });

  const env = envFor({
    appUrl: E2E_WEB_ORIGIN,
    apiPort: E2E_API_PORT,
    database: postgres.getDatabase(),
    redisDb: 0,
  });

  const setupEnv = envFor({
    appUrl: E2E_SETUP_ORIGIN,
    apiPort: E2E_SETUP_API_PORT,
    database: SETUP_DATABASE,
    redisDb: 1,
    servesAdmin: true,
    setupKey: E2E_SETUP_KEY,
  });

  await postgres.exec([
    'psql',
    '-U',
    postgres.getUsername(),
    '-d',
    postgres.getDatabase(),
    '-c',
    `CREATE DATABASE ${SETUP_DATABASE}`,
  ]);

  const seeded = JSON.parse(
    await run(path.join(apiRoot, 'dist/seed/seed-dev.js'), env, [
      '--with-totp',
      '--with-invite',
      '--json',
    ]),
  ) as { userId: string; email: string; password: string; totpSecret: string; inviteToken: string };

  process.env[OIDC_CONTROL_KEY_ENV] = oidc.controlKey;
  process.env[SAML_CONTROL_KEY_ENV] = saml.controlKey;
  process.env[SAML_CERTIFICATE_ENV] = saml.certificate;

  const oidcSeed = JSON.parse(
    await run(path.join(apiRoot, 'dist/seed/seed-oidc.js'), env, [seeded.userId]),
  ) as { connectionId: string };
  process.env[SSO_CONNECTION_ENV] = oidcSeed.connectionId;
  const samlSeed = JSON.parse(
    await run(path.join(apiRoot, 'dist/seed/seed-saml.js'), env, [seeded.userId, saml.certificate]),
  ) as { connectionId: string };
  process.env[SAML_CONNECTION_ENV] = samlSeed.connectionId;

  // A worker beside the seeded api, as in production: the outbox relay and
  // the event handlers are what carry an agent's reply to the widget's socket
  // (M4-04), and a notification to a desk.
  const workerEnv = { ...env, APP_ROLE: 'worker' };

  const processes = [env, workerEnv, setupEnv].map((processEnv) =>
    spawn(process.execPath, [entry], {
      cwd: apiRoot,
      env: { ...process.env, ...processEnv },
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  );

  // The processes first, and only then their containers: a worker still
  // draining its queues would otherwise spend its shutdown reconnecting to a
  // Redis that is already gone.
  const stopEverything = async (signal: NodeJS.Signals): Promise<void> => {
    await Promise.all(
      processes.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.once('exit', () => {
              clearTimeout(force);
              resolve();
            });
            child.kill(signal);
          }),
      ),
    );
    await Promise.all([
      postgres.stop(),
      redis.stop(),
      telegram.stop(),
      graph.stop(),
      oidc.close(),
      saml.close(),
    ]);
  };

  try {
    await Promise.all([waitForHealth(E2E_API_ORIGIN), waitForHealth(E2E_SETUP_ORIGIN)]);
    const metadata = await (await fetch(`${E2E_API_ORIGIN}/api/auth/sso/saml/metadata`)).text();
    const certificate = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(metadata)?.[1];
    if (!certificate) throw new Error('SP metadata is missing its certificate');
    saml.controls.spCertificate = `-----BEGIN CERTIFICATE-----\n${certificate.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`;
  } catch (error) {
    await stopEverything('SIGKILL');
    throw error;
  }

  // Playwright hands the workers this process's environment, which is how a
  // secret drawn at seed time reaches a spec in another process.
  process.env[ACCOUNT_EMAIL_ENV] = seeded.email;
  process.env[ACCOUNT_PASSWORD_ENV] = seeded.password;
  process.env[TOTP_SECRET_ENV] = seeded.totpSecret;
  process.env[INVITE_TOKEN_ENV] = seeded.inviteToken;
  process.env[API_ENV_ENV] = JSON.stringify(env);
  process.env[REDIS_CONTAINER_ENV] = redis.getId();

  return { stop: () => stopEverything('SIGTERM') };
};

export interface ApiReplica {
  readonly origin: string;
  /** Ends the process at once, as a crash or `docker kill` would, and waits for it to exit. */
  kill(): Promise<void>;
}

/**
 * A second api process of the seeded install, on a port of its own: the same
 * database, Redis and master key, so it serves the same brands and visitors,
 * and receives the worker's events through the same Redis channel as any
 * replica (DOMAIN-RULES §7).
 *
 * It exists for the one spec that has to stop an api under a live widget.
 * Stopping the api every other spec uses would fail whichever ran next;
 * stopping a replica only this spec talks to fails nothing.
 */
export const startApiReplica = async (port: number): Promise<ApiReplica> => {
  const seededEnv = process.env[API_ENV_ENV];
  if (seededEnv === undefined) {
    throw new Error(`${API_ENV_ENV} is not set: the global setup did not start the install.`);
  }
  const origin = `http://localhost:${String(port)}`;
  const child = spawn(process.execPath, [path.join(apiRoot, 'dist/main.js')], {
    cwd: apiRoot,
    env: {
      ...process.env,
      ...(JSON.parse(seededEnv) as NodeJS.ProcessEnv),
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const kill = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
  };

  try {
    await waitForHealth(origin);
  } catch (error) {
    await kill();
    throw error;
  }

  return { origin, kill };
};

const CLEAR_STEP_UP_SCRIPT =
  "for _, key in ipairs(redis.call('KEYS', 'auth:rate:step-up:*')) do redis.call('DEL', key) end";

/**
 * Gives the seeded account its step-up budget back (five proofs per quarter
 * hour). Every spec that re-proves a credential signs in as that one account,
 * so together they would spend a budget that each is entitled to alone.
 */
export const resetStepUpBudget = async (): Promise<void> => {
  const container = process.env[REDIS_CONTAINER_ENV];
  if (container === undefined) throw new Error('The install did not publish its Redis container.');
  await promisify(execFile)('docker', [
    'exec',
    container,
    'redis-cli',
    '-n',
    '0',
    'EVAL',
    CLEAR_STEP_UP_SCRIPT,
    '0',
  ]);
};
