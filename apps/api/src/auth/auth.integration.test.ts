import type { EmailMessage } from '@helpdock/channels';
import { createKeyring, type Env } from '@helpdock/config';
import {
  auditLog,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  users,
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { desc, eq, like, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApiApp,
  createApiApp,
  createRuntime,
  type Runtime,
  resetUntrustedForwardingWarningForTests,
} from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { OidcService } from '../sso/oidc.service.js';
import { QueuedAuthMail } from '../testing/auth-mail.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { forgetUsedTotpSteps } from '../testing/staff-sign-in.js';
import { OAUTH_STATE_TTL_SECONDS } from './oauth/oauth.service.js';
import { RateLimiter, SIGN_IN_EMAIL_RULE, SIGN_IN_IP_RULE } from './rate-limit.js';
import { hashSubject, PRINCIPAL_REVOKED_CHANNEL, rateLimitKey } from './redis-keys.js';
import { oauthNonceCookie, refreshCookieOf, trustedDeviceCookie } from './session/cookies.js';

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
const METRICS_TOKEN = 'metrics-token-for-the-auth-suite';
const MASTER_KEY = Buffer.alloc(32, 11).toString('base64');
const APP_URL = 'https://support.example.com';
/** Over https the cookies carry the `__Secure-` prefix (ASVS 3.4.4). */
const REFRESH_COOKIE = refreshCookieOf({ APP_URL }).name;
const TRUSTED_DEVICE_COOKIE = trustedDeviceCookie(APP_URL).name;
const OAUTH_NONCE_COOKIE = oauthNonceCookie(APP_URL, OAUTH_STATE_TTL_SECONDS, 'google').name;

/**
 * The origin a redirect lands on. Compared as a parsed origin, not a prefix:
 * `https://support.example.com.evil.test` starts with the app URL too.
 */
const originOf = (location: unknown): string | undefined =>
  location === undefined ? undefined : new URL(String(location)).origin;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the auth integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the auth service', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  /** What the api queued; a test follows the link out of it. */
  let email: QueuedAuthMail;
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
      METRICS_TOKEN,
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

  /**
   * A code for the seeded authenticator. The api accepts each step once, and
   * these tests sign in faster than steps roll over, so the used step is
   * forgotten first; the one test about replay does not use this.
   */
  const totpCode = async (): Promise<string> => {
    await forgetUsedTotpSteps(runtime.redis);
    return generate({ secret: seeded.totpSecret ?? '', period: 30 });
  };

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
    app = await createApiApp({ runtime });
    email = new QueuedAuthMail({ db: runtime.db, keyring: createKeyring(env) });
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
        sso: [],
        ssoEnforced: false,
        password: true,
        magicLink: true,
        // Neither provider has a client id in settings, so neither button is drawn.
        oauth: { google: false, github: false },
        // APP_URL is https, and nothing has pinned another host.
        passkey: true,
        passkeysPaused: false,
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

    it('answers "rate-limited" once the per-address limit is spent', async () => {
      const attempts = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        attempts.push(await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' }));
      }

      expect(attempts.slice(0, 10).every((response) => response.statusCode === 401)).toBe(true);
      expect(Number(attempts.at(-1)?.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(attempts.at(-1)?.headers['retry-after'])).toBeLessThanOrEqual(900);
      expect(attempts.at(-1)?.statusCode).toBe(429);
      expect(attempts.at(-1)?.json()).toMatchObject({ error: { auth: { code: 'rate-limited' } } });
    });

    it('refuses a body that is not a sign-in, naming the fields', async () => {
      const response = await post('/api/auth/sign-in', { email: 'nope' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'validation_failed', fields: expect.any(Array) },
      });
    });
  });

  describe('failures-only sign-in limits (#343)', () => {
    it('allows 25 complete successful sign-ins from one IP without changing its budget', async () => {
      for (let i = 0; i < 25; i++) await signIn();
      const keys = await runtime.redis.keys('auth:rate:signin-ip:*');
      for (const key of keys) expect(await runtime.redis.zcard(key)).toBe(0);
    });

    it('clears address failures after success but retains earlier IP failures', async () => {
      for (let i = 0; i < 9; i++) {
        expect(
          (await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' })).statusCode,
        ).toBe(401);
      }
      await signIn();
      for (let i = 0; i < 10; i++) {
        expect(
          (await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' })).statusCode,
        ).toBe(401);
      }
      const keys = await runtime.redis.keys('auth:rate:signin-ip:*');
      expect(keys).toHaveLength(1);
      expect(await runtime.redis.zcard(keys[0] ?? '')).toBe(19);
    });

    it('locks the IP after 100 failures across addresses and gives the same refusal for known and unknown accounts', async () => {
      for (let i = 0; i < 100; i++) {
        expect(
          (
            await post('/api/auth/sign-in', {
              email: `unknown-${i}@example.com`,
              password: 'wrong',
            })
          ).statusCode,
        ).toBe(401);
      }
      const known = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      const unknown = await post('/api/auth/sign-in', {
        email: 'another@example.com',
        password: 'wrong',
      });
      for (const response of [known, unknown]) {
        expect(response.statusCode).toBe(429);
        expect(response.json().error.auth).toEqual({ code: 'rate-limited' });
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(900);
      }
      const { requestId: _known, ...knownBody } = known.json().error;
      const { requestId: _unknown, ...unknownBody } = unknown.json().error;
      expect(knownBody).toEqual(unknownBody);
    });

    it('allows exactly ten parallel failed verifications and refuses the rest atomically', async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, () =>
          post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' }),
        ),
      );
      expect(results.filter((result) => result.statusCode === 401)).toHaveLength(10);
      expect(results.filter((result) => result.statusCode === 429)).toHaveLength(20);
      const keys = await runtime.redis.keys('auth:rate:signin-ip:*');
      expect(await runtime.redis.zcard(keys[0] ?? '')).toBe(10);
    });

    it('atomically bounds a parallel spray across addresses to 100 verifications', async () => {
      const limiter = new RateLimiter(runtime.redis);
      const attempts = await Promise.all(
        Array.from({ length: 150 }, (_, index) =>
          limiter.reserveSignIn('spray', `person-${index}@example.com`),
        ),
      );
      expect(attempts.filter((attempt) => attempt.retryAfter === 0)).toHaveLength(100);
      expect(attempts.filter((attempt) => attempt.retryAfter > 0)).toHaveLength(50);
    });

    it('returns the larger oldest-entry expiry from real Redis without extending the lock', async () => {
      const now = Date.now();
      const ipKey = rateLimitKey(SIGN_IN_IP_RULE.bucket, hashSubject('office'));
      const emailKey = rateLimitKey(SIGN_IN_EMAIL_RULE.bucket, hashSubject('person@example.com'));
      for (let i = 0; i < 100; i++) await runtime.redis.zadd(ipKey, now - 60_000, `ip-${i}`);
      for (let i = 0; i < 10; i++) await runtime.redis.zadd(emailKey, now - 30_000, `email-${i}`);
      const limiter = new RateLimiter(runtime.redis);
      const refused = await limiter.reserveSignIn('office', 'person@example.com');
      expect(refused.retryAfter).toBeGreaterThanOrEqual(869);
      expect(refused.retryAfter).toBeLessThanOrEqual(870);
      expect(await runtime.redis.zcard(ipKey)).toBe(100);
      expect(await runtime.redis.zcard(emailKey)).toBe(10);
    });

    it('warns once when forwarded requests arrive with proxy trust off without logging the header', async () => {
      resetUntrustedForwardingWarningForTests();
      const logStart = logLines.length;
      for (let i = 0; i < 2; i++) {
        await get('/api/auth/methods', { 'x-forwarded-for': 'forwarded-header-marker' });
      }
      const warnings = logLines
        .slice(logStart)
        .filter((line) => line.includes('X-Forwarded-For received while TRUST_PROXY is off'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('forwarded-header-marker');
    });

    it('opens a session after nine password failures and a correct password and TOTP (#343)', async () => {
      for (let attempt = 0; attempt < 9; attempt++) {
        const failed = await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' });
        expect(failed.statusCode).toBe(401);
      }
      const first = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      expect(first.statusCode).toBe(201);
      expect(first.json().kind).toBe('totp-required');
      const second = await post('/api/auth/totp', {
        challengeId: first.json().challengeId,
        code: await totpCode(),
        trustDevice: false,
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().accessToken).toEqual(expect.any(String));
      expect(cookieOf(second, REFRESH_COOKIE)).toEqual(expect.any(String));
    });

    it('never lets bad TOTP codes spend the address budget, so rounds of them do not lock the password step (#343)', async () => {
      const badCode = (await totpCode()) === '000000' ? '111111' : '000000';
      for (let round = 1; round <= 6; round++) {
        const first = await post('/api/auth/sign-in', {
          email: seeded.email,
          password: seeded.password,
        });
        expect(first.statusCode).toBe(201);
        expect(first.json().kind).toBe('totp-required');
        const challengeId = first.json().challengeId as string;
        for (let guess = 0; guess < 2; guess++) {
          const response = await post('/api/auth/totp', {
            challengeId,
            code: badCode,
            trustDevice: false,
          });
          expect(response.statusCode).toBe(401);
          expect(response.json().error.auth).toEqual({
            code: 'totp-mismatch',
            attemptsLeft: 2 - guess,
          });
        }
      }
      expect(await runtime.redis.keys('auth:rate:signin-email:*')).toEqual([]);
    });

    it('keeps TOTP guessing capped at three per challenge when the address budget is spent (#343)', async () => {
      const link = await post('/api/auth/magic-link', { email: seeded.email });
      expect(link.statusCode).toBe(204);
      const token = tokenOf(linkIn(await email.last()));
      const started = await post('/api/auth/magic-link/consume', { token });
      const challengeId = started.json().challengeId as string;
      const badCode = (await totpCode()) === '000000' ? '111111' : '000000';

      const codes: string[] = [];
      for (let guess = 0; guess < 3; guess++) {
        const response = await post('/api/auth/totp', {
          challengeId,
          code: badCode,
          trustDevice: false,
        });
        codes.push(response.json().error.auth.code);
      }
      expect(codes).toEqual(['totp-mismatch', 'totp-mismatch', 'totp-locked']);
    });

    it('verifies a magic-link TOTP challenge after junk passwords exhaust the address budget (#343)', async () => {
      expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);
      const token = tokenOf(linkIn(await email.last()));
      const started = await post('/api/auth/magic-link/consume', { token });
      expect(started.json().kind).toBe('totp-required');

      for (let attempt = 0; attempt < 10; attempt++) {
        await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' });
      }
      const blocked = await post('/api/auth/sign-in', { email: seeded.email, password: 'wrong' });
      expect(blocked.statusCode).toBe(429);

      const verified = await post('/api/auth/totp', {
        challengeId: started.json().challengeId,
        code: await totpCode(),
        trustDevice: false,
      });
      expect(verified.statusCode).toBe(201);
      expect(verified.json().accessToken).toEqual(expect.any(String));
      // Completing every factor is what clears the address bucket.
      expect(await runtime.redis.keys('auth:rate:signin-email:*')).toEqual([]);
    });

    it('counts failed TOTP codes and refunds success without erasing earlier IP failures', async () => {
      const first = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      const challengeId = (first.json() as { challengeId: string }).challengeId;
      const goodCode = await totpCode();
      const badCode = goodCode === '000000' ? '111111' : '000000';
      for (let i = 0; i < 2; i++) {
        expect(
          (await post('/api/auth/totp', { challengeId, code: badCode, trustDevice: false }))
            .statusCode,
        ).toBe(401);
      }
      expect(
        (await post('/api/auth/totp', { challengeId, code: goodCode, trustDevice: false }))
          .statusCode,
      ).toBe(201);
      const ipKeys = await runtime.redis.keys('auth:rate:signin-ip:*');
      expect(await runtime.redis.zcard(ipKeys[0] ?? '')).toBe(2);
      expect(await runtime.redis.keys('auth:rate:signin-email:*')).toEqual([]);
    });

    it.each(['/api/auth/totp', '/api/auth/recovery-code', '/api/auth/enrolment/confirm'])(
      'counts expired challenges in the IP bucket on %s',
      async (path) => {
        const limiter = new RateLimiter(runtime.redis);
        for (let i = 0; i < 99; i++) await limiter.reserveSignIn('127.0.0.1');
        const body = {
          challengeId: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
          code: '000000',
          trustDevice: false,
        };
        expect((await post(path, body)).statusCode).toBe(401);
        const refused = await post(path, body);
        expect(refused.statusCode).toBe(429);
        expect(refused.json().error.auth).toEqual({ code: 'rate-limited' });
      },
    );

    it('SSO discovery and OIDC starts never spend the password budget', async () => {
      const oidc = new OidcService({
        db: runtime.db,
        redis: runtime.redis,
        logger: runtime.logger,
        keyring: createKeyring(envFor()),
        env: envFor(),
      });
      for (let i = 0; i < 25; i++) {
        await expect(
          oidc.start({
            connectionId: '0192c3f0-1a2b-7c3d-8e4f-000000000001',
            returnTo: '/tickets',
            ip: '127.0.0.1',
          }),
        ).rejects.toThrow(i < 20 ? 'sso-connection-disabled' : 'sso-rate-limited');
        await post('/api/auth/sso/discover', { email: seeded.email });
      }
      expect(await runtime.redis.keys('auth:rate:signin-*')).toEqual([]);
      const ssoKeys = await runtime.redis.keys('auth:rate:sso-*');
      expect(ssoKeys.length).toBeGreaterThan(0);
      await signIn();
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

    it('refuses /api/auth/me without a bearer token, with no credential refusal in the body', async () => {
      const refused = await get('/api/auth/me');

      // The admin refreshes on a 401 only when `error.auth` is absent (#271).
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error).not.toHaveProperty('auth');
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
      const before = await email.count();

      const response = await post('/api/auth/magic-link', { email: 'nobody@helpdock.test' });

      expect(response.statusCode).toBe(204);
      expect(await email.count()).toBe(before);
    });

    it('queues the link through the outbox, sealed, and never logs it', async () => {
      logLines.length = 0;

      expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);

      const message = await email.last();
      const token = tokenOf(linkIn(message));
      expect(token.length).toBeGreaterThan(20);
      expect(message.locale).toBe('en');
      expect(JSON.stringify(await email.payloads())).not.toContain(token);
      expect(logLines.join('\n')).not.toContain(token);
    });

    it('links to the confirm screen, with the token where no server sees it', async () => {
      await post('/api/auth/magic-link', { email: seeded.email });

      expect(linkIn(await email.last())).toMatch(/^\/sign-in\/magic#token=[A-Za-z0-9_-]+$/);
    });

    it('keeps the token out of the request log, on the old path and on the new calls', async () => {
      await post('/api/auth/magic-link', { email: seeded.email });
      const token = tokenOf(linkIn(await email.last()));
      logLines.length = 0;

      await get(`/api/auth/magic-link/${token}`);
      await post('/api/auth/magic-link/preview', { token });
      await post('/api/auth/magic-link/consume', { token });

      // The route shape may be logged. The credential in it may not.
      expect(logLines.join('\n')).toContain('/api/auth/magic-link/:token');
      expect(logLines.join('\n')).toContain('/api/auth/magic-link/consume');
      expect(logLines.join('\n')).not.toContain(token);
    });

    it('spends nothing when a scanner follows a link sent before the confirm screen (M9-01 F6)', async () => {
      await post('/api/auth/magic-link', { email: seeded.email });
      const token = tokenOf(linkIn(await email.last()));

      for (let fetch = 0; fetch < 2; fetch += 1) {
        const followed = await get(`/api/auth/magic-link/${token}`);
        expect(followed.statusCode).toBe(302);
        expect(followed.headers.location).toBe(`${APP_URL}/sign-in/magic#token=${token}`);
        expect(followed.cookies).toEqual([]);
      }

      const consumed = await post('/api/auth/magic-link/consume', { token });
      expect(consumed.statusCode).toBe(201);
    });

    it('previews whose account the link opens, as often as it is asked, without spending it', async () => {
      await post('/api/auth/magic-link', { email: seeded.email });
      const token = tokenOf(linkIn(await email.last()));

      for (let look = 0; look < 2; look += 1) {
        const preview = await post('/api/auth/magic-link/preview', { token });
        expect(preview.statusCode).toBe(200);
        expect(preview.json()).toEqual({ email: seeded.email, expiresInMinutes: 10 });
      }

      expect((await post('/api/auth/magic-link/consume', { token })).statusCode).toBe(201);
    });

    it('answers a dead link the same way to the preview and to the click', async () => {
      for (const path of ['/api/auth/magic-link/preview', '/api/auth/magic-link/consume']) {
        const response = await post(path, { token: 'never-issued' });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
      }
    });

    it('signs in on the click, once, through the second factor', async () => {
      expect((await post('/api/auth/magic-link', { email: seeded.email })).statusCode).toBe(204);
      const token = tokenOf(linkIn(await email.last()));

      const first = await post('/api/auth/magic-link/consume', { token });
      // This account has a second factor, so the click hands over to the code
      // screen rather than signing in outright.
      expect(first.statusCode).toBe(201);
      const challenge = first.json() as { kind: string; challengeId: string; email: string };
      expect(challenge).toMatchObject({ kind: 'totp-required', email: seeded.email });

      const second = await post('/api/auth/totp', {
        challengeId: challenge.challengeId,
        code: await totpCode(),
        trustDevice: false,
      });
      expect(second.statusCode).toBe(201);
      expect(cookieOf(second, REFRESH_COOKIE)).toBeDefined();

      const again = await post('/api/auth/magic-link/consume', { token });
      expect(again.statusCode).toBe(401);
      expect(again.json()).toMatchObject({ error: { auth: { code: 'challenge-expired' } } });
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
      const token = new URL(linkIn(await email.last()), APP_URL).searchParams.get('token') ?? '';

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
      expect(originOf(response.headers.location)).toBe(new URL(APP_URL).origin);
    });

    it('sends a callback for a provider it does not have to a screen', async () => {
      const response = await get('/api/auth/oauth/facebook/callback?code=c&state=s');

      expect(response.statusCode).toBe(302);
      expect(new URL(String(response.headers.location)).searchParams.get('error')).toBe(
        'no-account',
      );
    });

    it('refuses a provider it does not have', async () => {
      expect((await get('/api/auth/oauth/facebook/start')).statusCode).toBe(403);
    });

    // F4 (M9-01): a captured callback URL must not sign a victim's browser in as
    // whoever began the flow.
    describe('with Google configured', () => {
      const callbackWith = (state: string, nonce?: string) =>
        get(
          `/api/auth/oauth/google/callback?code=c&state=${state}`,
          nonce === undefined ? {} : { cookie: `${OAUTH_NONCE_COOKIE}=${nonce}` },
        );

      const begin = async () => {
        const started = await get('/api/auth/oauth/google/start');
        return {
          started,
          state: new URL(String(started.headers.location)).searchParams.get('state') ?? '',
          nonce: started.cookies.find((cookie) => cookie.name === OAUTH_NONCE_COOKIE)?.value ?? '',
        };
      };

      beforeAll(async () => {
        await runtime.settings.set('oauth.google.clientId', 'client-id', { updatedBy: 'test' });
        await runtime.settings.set('oauth.google.clientSecret', 'client-secret', {
          updatedBy: 'test',
        });
      });

      afterAll(async () => {
        await runtime.settings.set('oauth.google.clientId', '', { updatedBy: 'test' });
        await runtime.settings.set('oauth.google.clientSecret', '', { updatedBy: 'test' });
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it('gives the browser that starts a flow a short-lived cookie only the OAuth routes receive', async () => {
        const { started, nonce } = await begin();

        expect(started.statusCode).toBe(302);
        expect(started.cookies.find((cookie) => cookie.name === OAUTH_NONCE_COOKIE)).toMatchObject({
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
          path: '/api/auth/oauth/google',
          maxAge: OAUTH_STATE_TTL_SECONDS,
        });
        expect(nonce).not.toBe('');
      });

      it.each([
        ['without that cookie', undefined],
        ['with the cookie of another flow', 'a-nonce-this-flow-never-issued'],
      ])(
        'refuses a callback from a browser %s, signs nobody in and clears the cookie',
        async (_case, nonce) => {
          const fetchMock = vi.fn();
          vi.stubGlobal('fetch', fetchMock);
          const { state } = await begin();

          const response = await callbackWith(state, nonce);

          expect(response.statusCode).toBe(302);
          expect(new URL(String(response.headers.location)).searchParams.get('error')).toBe(
            'no-account',
          );
          expect(response.cookies.some((cookie) => cookie.name === REFRESH_COOKIE)).toBe(false);
          expect(
            response.cookies.find((cookie) => cookie.name === OAUTH_NONCE_COOKIE),
          ).toMatchObject({ value: '', path: '/api/auth/oauth/google' });
          expect(fetchMock).not.toHaveBeenCalled();
        },
      );

      it('takes the browser that started the flow on to the provider, and clears the cookie either way', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
        vi.stubGlobal('fetch', fetchMock);
        const { state, nonce } = await begin();

        const response = await callbackWith(state, nonce);

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(response.cookies.find((cookie) => cookie.name === OAUTH_NONCE_COOKIE)).toMatchObject(
          { value: '', path: '/api/auth/oauth/google' },
        );
      });
    });
  });

  describe('M9 hardening (ASVS)', () => {
    const authRows = () =>
      withTenant(
        runtime.db,
        {
          brandIds: [INSTALL_SCOPE_BRAND_ID],
          departmentIds: 'all',
          principalType: 'system',
          principalId: 'test',
        },
        (tx) =>
          tx
            .select()
            .from(auditLog)
            .where(like(auditLog.action, 'auth.%'))
            .orderBy(desc(auditLog.createdAt)),
      );

    it('writes sign-ins to the install-scope audit trail, with where they came from', async () => {
      await post(
        '/api/auth/sign-in',
        { email: seeded.email, password: 'not the password' },
        { 'user-agent': 'Audit-Probe/1.0' },
      );

      const [row] = await authRows();
      expect(row).toMatchObject({
        brandId: INSTALL_SCOPE_BRAND_ID,
        action: 'auth.sign_in.failed',
        actorType: 'system',
        actorId: 'auth',
        targetType: 'user',
        targetId: seeded.userId,
        userAgent: 'Audit-Probe/1.0',
        meta: { method: 'password', reason: 'wrong-password' },
      });
      expect(row?.ip).not.toBeNull();
      expect(row?.requestId).not.toBeNull();

      await signIn();
      expect((await authRows())[0]).toMatchObject({
        action: 'auth.sign_in.succeeded',
        actorType: 'staff',
        actorId: seeded.userId,
        meta: { method: 'password', secondFactor: 'totp' },
      });
    });

    it('accepts an authenticator code once, in Redis, whichever challenge it is typed into', async () => {
      await forgetUsedTotpSteps(runtime.redis);
      const code = await generate({ secret: seeded.totpSecret ?? '', period: 30 });
      const answer = async () => {
        const started = await post('/api/auth/sign-in', {
          email: seeded.email,
          password: seeded.password,
        });
        return post('/api/auth/totp', {
          challengeId: (started.json() as { challengeId: string }).challengeId,
          code,
          trustDevice: false,
        });
      };

      expect((await answer()).statusCode).toBe(201);
      const replayed = await answer();

      expect(replayed.statusCode).toBe(401);
      expect(replayed.json()).toMatchObject({ error: { auth: { code: 'totp-mismatch' } } });
      expect((await authRows())[0]).toMatchObject({ action: 'auth.second_factor.replayed' });
    });

    it('names the refresh cookie __Secure- and lets it live as long as the absolute limit', async () => {
      const started = await post('/api/auth/sign-in', {
        email: seeded.email,
        password: seeded.password,
      });
      const finished = await post('/api/auth/totp', {
        challengeId: (started.json() as { challengeId: string }).challengeId,
        code: await totpCode(),
        trustDevice: true,
      });

      const refresh = finished.cookies.find((cookie) => cookie.name === '__Secure-hd_refresh');
      expect(refresh).toMatchObject({ secure: true, httpOnly: true, path: '/api/auth' });
      expect(refresh?.maxAge).toBe(12 * 60 * 60);
      expect(refresh?.domain).toBeUndefined();
      expect(finished.cookies.map((cookie) => cookie.name)).toContain('__Secure-hd_trust');
    });

    it('marks every JSON answer as a download (ASVS 14.4.2)', async () => {
      const methods = await get('/api/auth/methods');
      const refused = await post('/api/auth/sign-in', { email: 'nope' });

      expect(methods.headers['content-disposition']).toBe('attachment; filename="api.json"');
      expect(refused.headers['content-disposition']).toBe('attachment; filename="api.json"');
    });

    it('counts refusals in rate_limit_refusals_total', async () => {
      for (let attempt = 0; attempt < 11; attempt += 1) {
        await post('/api/auth/sign-in', { email: 'flood@example.com', password: 'whatever it is' });
      }

      const metrics = await get('/metrics', { authorization: `Bearer ${METRICS_TOKEN}` });
      expect(metrics.body).toMatch(/rate_limit_refusals_total\{bucket="signin-email"\} [1-9]/);
    });

    it('limits link and reset requests per IP in their own bucket (M18-11)', async () => {
      const fromOneIp = (path: string, address: string) =>
        app.inject({
          method: 'POST',
          url: path,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email: address }),
          remoteAddress: '198.51.100.77',
        });

      for (let attempt = 0; attempt < 31; attempt += 1) {
        const path = attempt % 2 === 0 ? '/api/auth/magic-link' : '/api/auth/password/forgot';
        // The same answer either side of the limit, so it tells nobody it was hit.
        expect((await fromOneIp(path, `walker-${attempt}@example.com`)).statusCode).toBe(204);
      }

      const metrics = await get('/metrics', { authorization: `Bearer ${METRICS_TOKEN}` });
      expect(metrics.body).toMatch(/rate_limit_refusals_total\{bucket="email-dispatch-ip"\} 1\b/);
    });
  });

  /** Re-hashes with the same parameters the service uses, for the reset test's cleanup. */
  const rehash = async (password: string): Promise<string> => {
    const { PasswordHasher } = await import('./password.js');
    return new PasswordHasher(Buffer.from(MASTER_KEY, 'base64')).hash(password);
  };
});

/** The token out of a sign-in link's fragment. */
const tokenOf = (link: string): string =>
  new URLSearchParams(new URL(link, APP_URL).hash.slice(1)).get('token') ?? '';

/** The URL out of the plain-text body, which is the one line that is just a link. */
const linkIn = (message: EmailMessage): string => {
  const found = message.text.split('\n').find((line) => line.startsWith('http'));
  if (found === undefined) {
    throw new Error('the message carried no link');
  }

  return found.replace(APP_URL, '');
};
