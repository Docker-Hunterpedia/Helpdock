import { createKeyring, type Env, encryptSecret } from '@helpdock/config';
import {
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  userBrandRoles,
  users,
  uuidv7,
  webauthnCredentials,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { refreshCookieOf, trustedDeviceCookie } from '../auth/session/cookies.js';
import { hashRecoveryCodes, newRecoveryCodes } from '../auth/totp/recovery-codes.js';
import { newTotpSecret } from '../auth/totp/totp.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { SoftwareAuthenticator } from '../testing/software-authenticator.js';
import { forgetUsedTotpSteps } from '../testing/staff-sign-in.js';
import { writeSsoSetting } from './sso-settings.js';

/**
 * M18-05 over HTTP against a real Postgres and Redis: every combination of
 * enforcement (off, on) x account (break-glass, ordinary) x first factor
 * (local password, SSO) x second factor (app code, passkey with user
 * verification, passwordless passkey, recovery code, trusted browser). Under
 * enforcement only a listed install admin gets in, with a password and a fresh
 * code or a user-verified passkey, and nobody else does by any other road.
 * The SSO-first column is the pure table in `break-glass.test.ts` and the unit
 * scenarios in `auth.service.test.ts`; an SSO round trip needs an IdP.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 12);
const APP_URL = 'https://support.example.com';
const REFRESH_COOKIE = refreshCookieOf({ APP_URL }).name;
const PASSWORD = 'a long enough account password';
const SECRET = newTotpSecret();

const hasDocker = await dockerAvailable();

type Json = Record<string, unknown>;
type RequestOptions = Parameters<SoftwareAuthenticator['assert']>[0];

describe.skipIf(!hasDocker)('SSO enforcement and break-glass (ADR 0053)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  const envFor = (): Env =>
    ({
      APP_URL,
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY.toString('base64'),
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      METRICS_TOKEN: 'metrics-token-for-the-break-glass-suite',
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
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const call = (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    cookies: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: path,
      cookies,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  const system = {
    brandIds: [INSTALL_SCOPE_BRAND_ID],
    departmentIds: 'all' as const,
    principalType: 'system' as const,
    principalId: 'test',
  };
  const hasher = new PasswordHasher(MASTER_KEY);
  const keyring = () => createKeyring(envFor());
  const trustCookieName = () => trustedDeviceCookie(APP_URL).name;

  interface Account {
    readonly id: string;
    readonly email: string;
    readonly authenticator: SoftwareAuthenticator;
    readonly recoveryCodes: string[];
  }

  /**
   * An install admin (or an ordinary agent) with a password and the second
   * factors asked for. Recovery codes are always drawn, so the matrix proves
   * they open nothing under enforcement.
   */
  const makeAccount = async (options: {
    installAdmin: boolean;
    totp: boolean;
    passkey: boolean;
    passkeyVerified?: boolean;
  }): Promise<Account> => {
    const id = uuidv7();
    const email = `${id}@example.com`;
    const recoveryCodes = newRecoveryCodes(3);
    await runtime.db.insert(users).values({
      id,
      email,
      name: 'Lina Haddad',
      status: 'active',
      installAdmin: options.installAdmin,
      passwordHash: await hasher.hash(PASSWORD),
      recoveryCodesHashed: await hashRecoveryCodes(recoveryCodes, hasher),
      ...(options.totp
        ? { totpEnabled: true, totpSecretEncrypted: encryptSecret(SECRET, keyring()) }
        : {}),
    });
    await withTenant(runtime.db, { ...system, brandIds: [seeded.brandId] }, (tx) =>
      tx.insert(userBrandRoles).values({
        userId: id,
        brandId: seeded.brandId,
        role: options.installAdmin ? 'admin' : 'agent',
      }),
    );
    const authenticator = new SoftwareAuthenticator();
    if (options.passkey) {
      await runtime.db.insert(webauthnCredentials).values({
        userId: id,
        credentialId: authenticator.credentialId,
        publicKey: authenticator.cosePublicKey,
        algorithm: -7,
        backupEligible: false,
        backedUp: false,
        userVerified: options.passkeyVerified ?? true,
        name: 'Key',
      });
    }
    return { id, email, authenticator, recoveryCodes };
  };

  const setPolicy = (policy: { enforced: boolean; breakGlass?: string[] }) =>
    withSystem(runtime.db, INSTALL_SCOPE_BRAND_ID, async (tx) => {
      await writeSsoSetting(tx, keyring(), {
        key: 'sso.enforced',
        value: policy.enforced,
        actorId: seeded.userId,
      });
      await writeSsoSetting(tx, keyring(), {
        key: 'sso.breakGlassUserIds',
        value: policy.breakGlass ?? [],
        actorId: seeded.userId,
      });
    });

  const signIn = async (email: string, cookies: Record<string, string> = {}) => {
    const response = await call(
      'POST',
      '/api/auth/sign-in',
      { email, password: PASSWORD },
      cookies,
    );
    return { response, body: response.json() as Json & { challengeId: string } };
  };

  const authOf = (response: { json(): unknown }) =>
    (response.json() as { error: { auth: { code: string; attemptsLeft?: number } } }).error.auth;

  const sessionCookie = (response: { cookies: readonly { name: string }[] }) =>
    response.cookies.some((cookie) => cookie.name === REFRESH_COOKIE);

  const totpCode = async (): Promise<string> => {
    await forgetUsedTotpSteps(runtime.redis);
    return generate({ secret: SECRET, period: 30 });
  };

  const answerTotp = async (challengeId: string, code?: string) =>
    call('POST', '/api/auth/totp', {
      challengeId,
      code: code ?? (await totpCode()),
      trustDevice: false,
    });

  const answerRecovery = (challengeId: string, code: string) =>
    call('POST', '/api/auth/recovery-code', { challengeId, code });

  const passkeyOptions = async (challengeId: string) => {
    const response = await call('POST', '/api/auth/passkey/second-factor/options', { challengeId });
    return {
      response,
      ceremony: response.json() as { ceremonyId: string; options: RequestOptions },
    };
  };

  const answerPasskey = async (
    challengeId: string,
    authenticator: SoftwareAuthenticator,
    assertion: { userVerified?: boolean } = {},
  ) => {
    const { response: optionsResponse, ceremony } = await passkeyOptions(challengeId);
    if (optionsResponse.statusCode !== 200) return optionsResponse;
    return call('POST', '/api/auth/passkey/second-factor/verify', {
      challengeId,
      ceremonyId: ceremony.ceremonyId,
      response: authenticator.assert(ceremony.options, { origin: APP_URL, ...assertion }),
      trustDevice: false,
    });
  };

  const passwordlessSignIn = async (authenticator: SoftwareAuthenticator) => {
    const options = await call('POST', '/api/auth/passkey/options', {});
    if (options.statusCode !== 200) return options;
    const { ceremonyId, options: request } = options.json() as {
      ceremonyId: string;
      options: RequestOptions;
    };
    return call('POST', '/api/auth/passkey/verify', {
      ceremonyId,
      response: authenticator.assert(request, { origin: APP_URL }),
    });
  };

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
      destination: { write: () => {} },
    });
    runtime = await createRuntime({ env, logger });
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env, withTotp: true });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  afterEach(async () => {
    const keys = await runtime.redis.keys('auth:*');
    if (keys.length > 0) await runtime.redis.del(...keys);
    await setPolicy({ enforced: false });
  });

  describe('enforcement off', () => {
    it.each([
      ['a break-glass admin', true],
      ['an ordinary agent', false],
    ])('%s signs in with an app code, a passkey or a recovery code', async (_label, privileged) => {
      const account = await makeAccount({ installAdmin: privileged, totp: true, passkey: true });
      if (privileged) await setPolicy({ enforced: false, breakGlass: [account.id] });

      const first = await signIn(account.email);
      expect(first.body).toMatchObject({ factors: { totp: true, passkey: true } });
      expect(sessionCookie(await answerTotp(first.body.challengeId))).toBe(true);
      const second = await signIn(account.email);
      expect(
        sessionCookie(await answerPasskey(second.body.challengeId, account.authenticator)),
      ).toBe(true);
      const third = await signIn(account.email);
      expect(
        sessionCookie(await answerRecovery(third.body.challengeId, account.recoveryCodes[0] ?? '')),
      ).toBe(true);
      expect(sessionCookie(await passwordlessSignIn(account.authenticator))).toBe(true);
    });
  });

  describe('enforcement on, a break-glass admin', () => {
    it('signs in with the password and a fresh app code', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: false });
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const { body } = await signIn(account.email);

      expect(body).toMatchObject({
        kind: 'totp-required',
        factors: { totp: true, passkey: false },
      });
      expect(sessionCookie(await answerTotp(body.challengeId))).toBe(true);
    });

    it('signs in with the password and a passkey that carries user verification', async () => {
      const account = await makeAccount({ installAdmin: true, totp: false, passkey: true });
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const { body } = await signIn(account.email);

      expect(body).toMatchObject({ factors: { totp: false, passkey: true } });
      const verified = await answerPasskey(body.challengeId, account.authenticator);
      expect(verified.statusCode).toBe(201);
      expect(sessionCookie(verified)).toBe(true);
    });

    it('refuses a passkey without user verification, and charges an attempt', async () => {
      const account = await makeAccount({ installAdmin: true, totp: false, passkey: true });
      await setPolicy({ enforced: true, breakGlass: [account.id] });
      const { body } = await signIn(account.email);

      const verified = await answerPasskey(body.challengeId, account.authenticator, {
        userVerified: false,
      });

      expect(verified.statusCode).toBe(401);
      expect(authOf(verified)).toMatchObject({ code: 'passkey-invalid', attemptsLeft: 2 });
      expect(sessionCookie(verified)).toBe(false);
      const retry = await answerPasskey(body.challengeId, account.authenticator);
      expect(sessionCookie(retry)).toBe(true);
    });

    it('is refused a recovery code, a trusted browser, passwordless sign-in and a magic link', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: true });
      // The browser was trusted while enforcement was off.
      const trusted = await signIn(account.email);
      const trustedVerify = await call('POST', '/api/auth/totp', {
        challengeId: trusted.body.challengeId,
        code: await totpCode(),
        trustDevice: true,
      });
      const cookie = trustedVerify.cookies.find(
        (candidate) => candidate.name === trustCookieName(),
      );
      expect(cookie).toBeDefined();
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const again = await signIn(account.email, { [trustCookieName()]: cookie?.value ?? '' });
      expect(again.body.kind).toBe('totp-required');
      expect(sessionCookie(again.response)).toBe(false);
      const recovery = await answerRecovery(again.body.challengeId, account.recoveryCodes[0] ?? '');
      expect(recovery.statusCode).toBe(403);
      expect(authOf(recovery).code).toBe('sso-required');
      expect(sessionCookie(recovery)).toBe(false);
      const passwordless = await passwordlessSignIn(account.authenticator);
      expect(authOf(passwordless).code).toBe('sso-required');
      const link = await call('POST', '/api/auth/magic-link', { email: account.email });
      expect(authOf(link).code).toBe('sso-required');
      const [row] = await runtime.db.select().from(users).where(eq(users.id, account.id));
      expect(row?.recoveryCodesHashed).toHaveLength(3);
    });

    it('is refused when its only passkey registered without user verification', async () => {
      const account = await makeAccount({
        installAdmin: true,
        totp: false,
        passkey: true,
        passkeyVerified: false,
      });
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const { response } = await signIn(account.email);

      expect(response.statusCode).toBe(403);
      expect(authOf(response).code).toBe('sso-required');
      expect(sessionCookie(response)).toBe(false);
    });

    it('still signs in with its app when its passkey has no user verification', async () => {
      const account = await makeAccount({
        installAdmin: true,
        totp: true,
        passkey: true,
        passkeyVerified: false,
      });
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const { body } = await signIn(account.email);

      expect(sessionCookie(await answerTotp(body.challengeId))).toBe(true);
    });

    it('keeps its other factor when one is removed, so it is never locked out', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: true });
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      await runtime.db
        .delete(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, account.id));
      const withApp = await signIn(account.email);
      expect(withApp.body).toMatchObject({ factors: { totp: true, passkey: false } });
      expect(sessionCookie(await answerTotp(withApp.body.challengeId))).toBe(true);

      await runtime.db
        .update(users)
        .set({ totpEnabled: false, totpSecretEncrypted: null })
        .where(eq(users.id, account.id));
      await runtime.db.insert(webauthnCredentials).values({
        userId: account.id,
        credentialId: account.authenticator.credentialId,
        publicKey: account.authenticator.cosePublicKey,
        algorithm: -7,
        backupEligible: false,
        backedUp: false,
        userVerified: true,
        name: 'Key',
      });
      const withKey = await signIn(account.email);
      expect(
        sessionCookie(await answerPasskey(withKey.body.challengeId, account.authenticator)),
      ).toBe(true);
    });

    it('refuses a challenge begun before it was demoted from the list, and a ceremony minted before enforcement', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: true });
      const early = await signIn(account.email);
      const { ceremony } = await passkeyOptions(early.body.challengeId);
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const stale = await call('POST', '/api/auth/passkey/second-factor/verify', {
        challengeId: early.body.challengeId,
        ceremonyId: ceremony.ceremonyId,
        response: account.authenticator.assert(ceremony.options, { origin: APP_URL }),
        trustDevice: false,
      });
      expect(sessionCookie(stale)).toBe(false);
      expect(stale.statusCode).toBe(401);
      expect(
        sessionCookie(await answerPasskey(early.body.challengeId, account.authenticator)),
      ).toBe(true);

      const demoted = await signIn(account.email);
      await setPolicy({ enforced: true, breakGlass: [] });
      const refused = await answerTotp(demoted.body.challengeId);
      expect(authOf(refused).code).toBe('sso-required');
      expect(sessionCookie(refused)).toBe(false);
    });
  });

  describe('enforcement on, anyone else', () => {
    it.each([
      ['an install admin who is not listed', true],
      ['an ordinary agent', false],
    ])('%s cannot get in by any local road', async (_label, installAdmin) => {
      const listed = await makeAccount({ installAdmin: true, totp: true, passkey: true });
      const account = await makeAccount({ installAdmin, totp: true, passkey: true });
      // A challenge begun while enforcement was off.
      const pending = await signIn(account.email);
      const pendingCeremony = await passkeyOptions(pending.body.challengeId);
      await setPolicy({ enforced: true, breakGlass: [listed.id] });

      const password = await signIn(account.email);
      expect(password.response.statusCode).toBe(403);
      expect(authOf(password.response).code).toBe('sso-required');
      expect(sessionCookie(password.response)).toBe(false);

      const totp = await answerTotp(pending.body.challengeId);
      expect(authOf(totp).code).toBe('sso-required');
      const recovery = await answerRecovery(
        pending.body.challengeId,
        account.recoveryCodes[0] ?? '',
      );
      expect(authOf(recovery).code).toBe('sso-required');
      const passkey = await call('POST', '/api/auth/passkey/second-factor/verify', {
        challengeId: pending.body.challengeId,
        ceremonyId: pendingCeremony.ceremony.ceremonyId,
        response: account.authenticator.assert(pendingCeremony.ceremony.options, {
          origin: APP_URL,
        }),
        trustDevice: false,
      });
      expect(authOf(passkey).code).toBe('sso-required');
      expect(authOf(await passwordlessSignIn(account.authenticator)).code).toBe('sso-required');
      expect(
        authOf(await call('POST', '/api/auth/magic-link', { email: account.email })).code,
      ).toBe('sso-required');
      for (const response of [totp, recovery, passkey]) expect(sessionCookie(response)).toBe(false);
    });

    it('cannot borrow a listed admin’s challenge with its own passkey', async () => {
      const listed = await makeAccount({ installAdmin: true, totp: true, passkey: true });
      const outsider = await makeAccount({ installAdmin: false, totp: false, passkey: true });
      await setPolicy({ enforced: true, breakGlass: [listed.id] });
      const { body } = await signIn(listed.email);

      const response = await answerPasskey(body.challengeId, outsider.authenticator);

      expect(sessionCookie(response)).toBe(false);
      expect(response.statusCode).toBe(401);
    });
  });

  describe('replacing the authenticator app with a recovery code (#373)', () => {
    /** Signs in while enforcement is off, so the token exists to be used once it is on. */
    const tokenFor = async (account: Account): Promise<string> => {
      await setPolicy({ enforced: false });
      const { body } = await signIn(account.email);
      const answered = await answerTotp(body.challengeId);
      expect(answered.statusCode).toBe(201);
      return (answered.json() as { accessToken: string }).accessToken;
    };

    const startWith = (accessToken: string, proof: Json) =>
      app.inject({
        method: 'POST',
        url: '/api/me/totp/rotate/start',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        payload: JSON.stringify(proof),
      });

    const codesLeft = async (id: string): Promise<number> => {
      const [row] = await runtime.db
        .select({ hashed: users.recoveryCodesHashed })
        .from(users)
        .where(eq(users.id, id));
      return row?.hashed.length ?? 0;
    };

    it('refuses a break-glass admin a recovery code under enforcement, and spends nothing', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: false });
      const token = await tokenFor(account);
      await setPolicy({ enforced: true, breakGlass: [account.id] });

      const bare = await startWith(token, { recoveryCode: account.recoveryCodes[0] });
      const paired = await startWith(token, {
        recoveryCode: account.recoveryCodes[0],
        currentPassword: PASSWORD,
      });

      expect(bare.statusCode).toBe(403);
      expect(authOf(bare).code).toBe('recovery-code-not-allowed');
      expect(authOf(paired).code).toBe('recovery-code-not-allowed');
      expect(await codesLeft(account.id)).toBe(account.recoveryCodes.length);
    });

    it('refuses an eligible install admin who is not listed, and lets its app code through', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: false });
      const token = await tokenFor(account);
      await setPolicy({ enforced: true, breakGlass: [] });

      const refused = await startWith(token, { recoveryCode: account.recoveryCodes[0] });
      const allowed = await startWith(token, { code: await totpCode() });

      expect(authOf(refused).code).toBe('recovery-code-not-allowed');
      expect(allowed.statusCode).toBe(201);
    });

    it('lets an ordinary account use a recovery code under enforcement', async () => {
      const account = await makeAccount({ installAdmin: false, totp: true, passkey: false });
      const token = await tokenFor(account);
      await setPolicy({ enforced: true, breakGlass: [] });

      const response = await startWith(token, { recoveryCode: account.recoveryCodes[0] });

      expect(response.statusCode).toBe(201);
      expect(await codesLeft(account.id)).toBe(account.recoveryCodes.length - 1);
    });

    it('lets a break-glass admin use a recovery code while enforcement is off', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: false });
      const token = await tokenFor(account);
      await setPolicy({ enforced: false, breakGlass: [account.id] });

      const response = await startWith(token, { recoveryCode: account.recoveryCodes[0] });

      expect(response.statusCode).toBe(201);
    });

    it('tells the profile to hide the option for a break-glass account only while enforced', async () => {
      const account = await makeAccount({ installAdmin: true, totp: true, passkey: false });
      const token = await tokenFor(account);
      const profile = async () =>
        (
          await app.inject({
            method: 'GET',
            url: '/api/me/profile',
            headers: { authorization: `Bearer ${token}` },
          })
        ).json() as { recoveryCodeProofAllowed: boolean };

      await setPolicy({ enforced: false, breakGlass: [account.id] });
      expect((await profile()).recoveryCodeProofAllowed).toBe(true);
      await setPolicy({ enforced: true, breakGlass: [account.id] });
      expect((await profile()).recoveryCodeProofAllowed).toBe(false);
    });
  });
});
