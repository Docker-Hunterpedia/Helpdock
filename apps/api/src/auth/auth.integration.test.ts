import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EmailMessage, EmailSender } from '@helpdock/channels';
import type { Env } from '@helpdock/config';
import { createDb, type DbHandle, users } from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { PRINCIPAL_REVOKED_CHANNEL } from './redis-keys.js';
import { REFRESH_COOKIE, TRUSTED_DEVICE_COOKIE } from './session/cookies.js';

/**
 * The whole of M0-05 over HTTP, against a real Postgres and a real Redis: the
 * Lua that rotates a refresh token, the argon2 that verifies a password, the
 * row-level security the session read runs under, and the pub/sub that tells
 * M0-13 a principal is gone.
 *
 * The unit suites prove each piece decides correctly. This proves the pieces
 * are wired to each other, and it is the only place the scripts themselves run.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';

const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 11).toString('base64');
const APP_URL = 'https://support.example.com';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the auth integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

/** Collects what would have been sent, so a test can follow the link. */
class CollectingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  last(): EmailMessage {
    const message = this.sent.at(-1);
    if (message === undefined) {
      throw new Error('no email was sent');
    }

    return message;
  }
}

describe.skipIf(!hasDocker)('the auth service', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  const email = new CollectingEmailSender();
  /**
   * The log lines this run wrote. One test asserts on what a path does *not*
   * contain, which needs a logger that keeps them rather than a silent one.
   */
  const logLines: string[] = [];

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      DATABASE_MIGRATION_URL: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      // No admin build is served here; these tests speak to `/api/auth` only,
      // and the static module answers with its "no build found" warning.
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  /**
   * `content-type` is set only when there is a body, which is what the admin
   * adapter does too: Fastify refuses a request that announces JSON and sends
   * none, and `refresh` and `sign-out` send none.
   */
  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers });

  const cookieOf = (response: Awaited<ReturnType<typeof post>>, name: string): string | undefined =>
    response.cookies.find((cookie) => cookie.name === name)?.value;

  const totpCode = (): Promise<string> => generate({ secret: seeded.totpSecret ?? '', period: 30 });

  /** Password, then the second factor, ending in a session and its cookie. */
  const signIn = async (): Promise<{ accessToken: string; refreshCookie: string }> => {
    const first = await post('/api/auth/sign-in', {
      email: seeded.email,
      password: seeded.password,
    });
    expect(first.json()).toMatchObject({ kind: 'totp-required' });

    const second = await post('/api/auth/totp', {
      challengeId: (first.json() as { challengeId: string }).challengeId,
      code: await totpCode(),
      trustDevice: false,
    });
    expect(second.statusCode).toBe(201);

    return {
      accessToken: (second.json() as { accessToken: string }).accessToken,
      refreshCookie: cookieOf(second, REFRESH_COOKIE) ?? '',
    };
  };

  const bearer = (accessToken: string): Record<string, string> => ({
    authorization: `Bearer ${accessToken}`,
  });

  const withRefresh = (value: string): Record<string, string> => ({
    cookie: `${REFRESH_COOKIE}=${value}`,
  });

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    const env = envFor();
    const logger = createLogger({
      env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      level: 'info',
      destination: {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    });
    runtime = await createRuntime({ env, logger });
    app = await createApiApp({ runtime, emailSender: email });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  afterEach(async () => {
    // Rate-limit counters and locks are the only state that leaks between
    // tests; the accounts themselves are deliberately shared.
    const keys = await runtime.redis.keys('auth:rate:*');
    const locks = await runtime.redis.keys('auth:totp-lock:*');
    if ([...keys, ...locks].length > 0) {
      await runtime.redis.del(...keys, ...locks);
    }
  });

  describe('the ways in', () => {
    it('reports which methods this install offers, without a session', async () => {
      const response = await get('/api/auth/methods');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        password: true,
        magicLink: true,
        // Neither provider has a client id in settings, so neither button is drawn.
        oauth: { google: false, github: false },
      });
    });
  });

  describe('signing in with a password', () => {
    it('asks for the second factor, then issues a session and a refresh cookie', async () => {
      const first = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });

      expect(first.json()).toMatchObject({ kind: 'totp-required', email: seeded.email });
      expect(cookieOf(first, REFRESH_COOKIE)).toBeUndefined();

      const second = await post('/api/auth/totp', {
        challengeId: (first.json() as { challengeId: string }).challengeId,
        code: await totpCode(),
        trustDevice: false,
      });

      expect(second.json()).toMatchObject({
        kind: 'session',
        session: { user: { email: seeded.email, installAdmin: true } },
      });

      const cookie = second.cookies.find((found) => found.name === REFRESH_COOKIE);
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/auth' });
      expect(cookie?.secure).toBe(true);
    });

    it('answers a wrong password and an unknown address with the same code', async () => {
      const wrong = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: 'not the password',
      });
      const unknown = await post('/api/auth/sign-in', {
        email: 'nobody@helpdock.test',
        password: 'not the password',
      });

      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
      expect(unknown.json()).toMatchObject({ error: { auth: { code: 'invalid-credentials' } } });
    });

    it('spends argon2 on an unknown address too, so the two cost the same', async () => {
      // Not a stopwatch: a wall clock on a shared runner is flaky. What is
      // asserted is that both branches did the work — a decoy verification
      // leaves the hash in place and takes long enough to be measurable at all.
      const measure = async (address: string): Promise<number> => {
        const started = process.hrtime.bigint();
        await post('/api/auth/sign-in', { email: address, password: 'not the password' });
        return Number(process.hrtime.bigint() - started) / 1_000_000;
      };

      const known = await measure(seeded.email);
      const unknown = await measure('nobody@helpdock.test');

      expect(known).toBeGreaterThan(5);
      expect(unknown).toBeGreaterThan(5);
    });

    it('answers "unavailable" once the per-address limit is spent', async () => {
      const attempts = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        attempts.push(await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' }));
      }

      expect(attempts.at(-1)?.statusCode).toBe(429);
      expect(attempts.at(-1)?.json()).toMatchObject({ error: { auth: { code: 'unavailable' } } });
    });

    it('refuses a body that is not a sign-in, naming the fields', async () => {
      const response = await post('/api/auth/sign-in', { email: 'nope' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'validation_failed', fields: expect.any(Array) },
      });
    });
  });

  describe('the second factor', () => {
    it('locks the account after three wrong codes and says so', async () => {
      const started = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      const challengeId = (started.json() as { challengeId: string }).challengeId;

      const codes = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await post('/api/auth/totp', {
          challengeId,
          code: '000000',
          trustDevice: false,
        });
        codes.push((response.json() as { error: { auth: unknown } }).error.auth);
      }

      expect(codes).toEqual([
        { code: 'totp-mismatch', attemptsLeft: 2 },
        { code: 'totp-mismatch', attemptsLeft: 1 },
        { code: 'totp-locked' },
      ]);

      // And the lock holds for the next sign-in, after the password is proved.
      const blocked = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      expect(blocked.json()).toMatchObject({ error: { auth: { code: 'totp-locked' } } });
    });

    it('refuses a challenge it never issued', async () => {
      const response = await post('/api/auth/totp', {
        challengeId: 'made-up',
        code: '000000',
        trustDevice: false,
      });

      expect(response.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
    });

    it('skips the second factor on a browser the user trusted', async () => {
      const started = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      const trusted = await post('/api/auth/totp', {
        challengeId: (started.json() as { challengeId: string }).challengeId,
        code: await totpCode(),
        trustDevice: true,
      });

      const trustCookie = cookieOf(trusted, TRUSTED_DEVICE_COOKIE);
      expect(trustCookie).toBeDefined();

      const again = await post(
        '/api/auth/sign-in',
        { email: seeded.email, password: seeded.password },
        { cookie: `${TRUSTED_DEVICE_COOKIE}=${trustCookie ?? ''}` },
      );

      expect(again.json()).toMatchObject({ kind: 'session' });
    });
  });

  describe('the session', () => {
    it('answers /api/auth/me with the brands and roles the account holds', async () => {
      const { accessToken } = await signIn();

      const response = await get('/api/auth/me', bearer(accessToken));

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        user: { email: seeded.email, role: 'admin', installAdmin: true },
        brands: [{ id: seeded.brandId, ticketPrefix: 'HD' }],
        currentBrandId: seeded.brandId,
      });
    });

    it('refuses /api/auth/me without a bearer token', async () => {
      expect((await get('/api/auth/me')).statusCode).toBe(401);
    });

    it('rotates the refresh token and issues a new access token', async () => {
      const { refreshCookie } = await signIn();

      const response = await post('/api/auth/refresh', undefined, withRefresh(refreshCookie));

      expect(response.statusCode).toBe(201);
      expect(cookieOf(response, REFRESH_COOKIE)).not.toBe(refreshCookie);
      expect(response.json()).toMatchObject({ session: { user: { email: seeded.email } } });
    });

    it('revokes the whole family when a rotated token comes back, and says so on Redis', async () => {
      const { refreshCookie, accessToken } = await signIn();
      const rotated = await post('/api/auth/refresh', undefined, withRefresh(refreshCookie));
      const next = cookieOf(rotated, REFRESH_COOKIE) ?? '';

      const subscriber = new Redis(runtime.env.REDIS_URL);
      const announced = new Promise<string>((resolve) => {
        void subscriber.subscribe(PRINCIPAL_REVOKED_CHANNEL).then(() => {
          subscriber.on('message', (_channel, message: string) => {
            resolve(message);
          });
        });
      });
      // Give the subscription a moment to be established before the publish.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const reused = await post('/api/auth/refresh', undefined, withRefresh(refreshCookie));
      expect(reused.statusCode).toBe(401);

      expect(JSON.parse(await announced)).toMatchObject({
        principalType: 'staff',
        principalId: seeded.userId,
        reason: 'refresh-token-reuse',
      });
      await subscriber.quit();

      // The token the thief had, and the one the browser had, are both dead.
      expect((await post('/api/auth/refresh', undefined, withRefresh(next))).statusCode).toBe(401);
      // And the access token that family issued is refused inside its own TTL.
      expect((await get('/api/auth/me', bearer(accessToken))).statusCode).toBe(401);
    });

    it('refuses a made-up refresh cookie without saying why', async () => {
      const response = await post(
        '/api/auth/refresh',
        undefined,
        withRefresh('00000000-0000-7000-8000-000000000000.nope'),
      );

      expect(response.statusCode).toBe(401);
    });

    it('signs out one browser and leaves the other signed in', async () => {
      const one = await signIn();
      const two = await signIn();

      const response = await post('/api/auth/sign-out', undefined, {
        ...bearer(one.accessToken),
        ...withRefresh(one.refreshCookie),
      });

      expect(response.statusCode).toBe(204);
      expect((await get('/api/auth/me', bearer(one.accessToken))).statusCode).toBe(401);
      expect((await get('/api/auth/me', bearer(two.accessToken))).statusCode).toBe(200);
    });

    it('signs out everywhere', async () => {
      const one = await signIn();
      const two = await signIn();

      expect(
        (
          await post('/api/auth/sign-out-everywhere', undefined, {
            ...bearer(one.accessToken),
            ...withRefresh(one.refreshCookie),
          })
        ).statusCode,
      ).toBe(204);

      expect((await get('/api/auth/me', bearer(two.accessToken))).statusCode).toBe(401);
      expect(
        (await post('/api/auth/refresh', undefined, withRefresh(two.refreshCookie))).statusCode,
      ).toBe(401);
    });
  });

  describe('the magic link', () => {
    it('answers 204 for an unknown address and sends nothing', async () => {
      const before = email.sent.length;

      const response = await post('/api/auth/magic-link', { email: 'nobody@helpdock.test' });

      expect(response.statusCode).toBe(204);
      expect(email.sent).toHaveLength(before);
    });

    it('keeps the token out of the request log, where a path would otherwise put it', async () => {
      await post('/api/auth/magic-link', { email: seeded.email });
      const link = linkIn(email.last());
      const token = link.split('/').at(-1) ?? '';
      logLines.length = 0;

      await get(link);

      // The route shape may be logged. The credential in it may not.
      expect(logLines.join('\n')).toContain('/api/auth/magic-link/:token');
      expect(logLines.join('\n')).not.toContain(token);
    });

    it('sends a link that signs in once and then stops working', async () => {
      expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);

      const link = linkIn(email.last());
      const first = await get(link);

      expect(first.statusCode).toBe(302);
      // This account has a second factor, so the link hands over to the code
      // screen rather than signing in outright.
      expect(first.headers.location).toContain('challenge=');
      expect(first.headers.location?.toString().startsWith(APP_URL)).toBe(true);

      const second = await get(link);
      expect(second.headers.location).toContain('error=challenge-expired');
    });
  });

  describe('the password reset', () => {
    it('answers 204 for an unknown address', async () => {
      expect(
        (await post('/api/auth/password/forgot', { email: 'nobody@helpdock.test' })).statusCode,
      ).toBe(204);
    });

    it('changes the password, ends every session, and spends the link', async () => {
      const open = await signIn();
      expect((await get('/api/auth/me', bearer(open.accessToken))).statusCode).toBe(200);

      expect((await post('/api/auth/password/forgot', { email: seeded.email })).statusCode).toBe(
        204,
      );
      const token = new URL(linkIn(email.last()), APP_URL).searchParams.get('token') ?? '';

      const reset = await post('/api/auth/password/reset', {
        token,
        password: 'a whole new password',
      });
      expect(reset.statusCode).toBe(204);

      expect((await get('/api/auth/me', bearer(open.accessToken))).statusCode).toBe(401);
      expect(
        (await post('/api/auth/refresh', undefined, withRefresh(open.refreshCookie))).statusCode,
      ).toBe(401);

      // The new password works and the old one does not.
      expect(
        (
          await post('/api/auth/sign-in', {
            email: seeded.email,
            password: 'a whole new password',
          })
        ).json(),
      ).toMatchObject({ kind: 'totp-required' });
      expect(
        (await post('/api/auth/sign-in', { email: seeded.email, password: seeded.password }))
          .statusCode,
      ).toBe(401);

      // The link cannot be spent twice.
      expect(
        (await post('/api/auth/password/reset', { token, password: 'yet another password' }))
          .statusCode,
      ).toBe(401);

      // Put the seeded password back for whatever runs next.
      await runtime.db
        .update(users)
        .set({ passwordHash: await rehash(seeded.password) })
        .where(eq(users.id, seeded.userId));
    });
  });

  describe('OAuth', () => {
    it('refuses to start a provider with no client id', async () => {
      const response = await get('/api/auth/oauth/google/start');

      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { auth: { code: 'unavailable' } } });
    });

    it('sends a callback with no state back to a screen, never to another host', async () => {
      const response = await get('/api/auth/oauth/github/callback?code=c&state=s');

      expect(response.statusCode).toBe(302);
      expect(response.headers.location?.toString().startsWith(APP_URL)).toBe(true);
    });

    it('refuses a provider it does not have', async () => {
      expect((await get('/api/auth/oauth/facebook/start')).statusCode).toBe(403);
    });
  });

  /** Re-hashes with the same parameters the service uses, for the reset test's cleanup. */
  const rehash = async (password: string): Promise<string> => {
    const { PasswordHasher } = await import('./password.js');
    return new PasswordHasher(Buffer.from(MASTER_KEY, 'base64')).hash(password);
  };
});

/** The URL out of the plain-text body, which is the one line that is just a link. */
const linkIn = (message: EmailMessage): string => {
  const found = message.text.split('\n').find((line) => line.startsWith('http'));
  if (found === undefined) {
    throw new Error('the message carried no link');
  }

  return found.replace(APP_URL, '');
};
