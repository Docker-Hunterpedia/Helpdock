import { randomBytes } from 'node:crypto';
import {
  createKeyring,
  createSettings,
  InMemorySettingsStore,
  LocalInvalidation,
  type Settings,
} from '@helpdock/config';
import {
  APP_ROLE_NAME,
  auditLog,
  createDb,
  type DbHandle,
  INSTALL_SCOPE_BRAND_ID,
  runMigrations,
  settings as settingsTable,
  users,
  uuidv7,
  webauthnCredentials,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '../../testing/docker-available.js';
import { SoftwareAuthenticator } from '../../testing/software-authenticator.js';
import { WebAuthnCeremonyStore } from './ceremony-store.js';
import { RpIdPinStore } from './rp-id-pin.js';
import { type StoredPasskey, WebAuthnService } from './webauthn.service.js';

/**
 * The passkey foundation (M18-01) against a real Postgres and Redis: the
 * migration and its constraints, the RP ID pin under concurrency, and the
 * ceremony store's single use under concurrency. The registration and sign-in
 * routes arrive with M18-02 to M18-04; the last block runs the service end to
 * end over the real stores so they have a working base.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const APP_URL = 'https://desk.example.com';
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') });

const hasDocker = await dockerAvailable();

const settingsWith = (env: Record<string, string> = {}): Settings =>
  createSettings({
    env,
    store: new InMemorySettingsStore(),
    keyring,
    invalidation: new LocalInvalidation(),
  });

describe.skipIf(!hasDocker)('passkey foundation', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let handle: DbHandle;
  let redis: Redis;

  const db = () => handle.db;

  const addUser = async (): Promise<string> => {
    const id = uuidv7();
    await db()
      .insert(users)
      .values({ id, email: `${id}@example.com`, name: 'Lina Haddad', status: 'active' });
    return id;
  };

  const credential = (
    userId: string,
    overrides: Partial<typeof webauthnCredentials.$inferInsert> = {},
  ) => ({
    userId,
    credentialId: new Uint8Array(randomBytes(16)),
    publicKey: new Uint8Array(randomBytes(77)),
    algorithm: -7,
    backupEligible: false,
    backedUp: false,
    name: 'MacBook',
    ...overrides,
  });

  const clearPin = () =>
    withSystem(db(), INSTALL_SCOPE_BRAND_ID, async (tx) => {
      await tx
        .delete(settingsTable)
        .where(
          and(
            eq(settingsTable.brandId, INSTALL_SCOPE_BRAND_ID),
            eq(settingsTable.key, 'auth.webauthn.rpId'),
          ),
        );
      await tx.delete(auditLog).where(eq(auditLog.action, 'auth.passkey.rp_pinned'));
    });

  const pinAudits = () =>
    withSystem(db(), INSTALL_SCOPE_BRAND_ID, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'auth.passkey.rp_pinned')),
    );

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    handle = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
    });
    redis = new Redis(redisContainer.getConnectionUrl());
  }, 180_000);

  afterAll(async () => {
    redis?.disconnect();
    await handle?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('the migration', () => {
    it('stores a credential and reads its bytes back unchanged', async () => {
      const userId = await addUser();
      const row = credential(userId, { transports: ['usb', 'nfc'] });

      await db().insert(webauthnCredentials).values(row);
      const [stored] = await db()
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));

      expect(Buffer.from(stored?.credentialId ?? []).equals(Buffer.from(row.credentialId))).toBe(
        true,
      );
      expect(stored).toMatchObject({ signCount: 0, transports: ['usb', 'nfc'], aaguid: null });
    });

    it('refuses a credential id that is already registered, to anyone', async () => {
      const row = credential(await addUser());
      await db().insert(webauthnCredentials).values(row);

      await expect(
        db()
          .insert(webauthnCredentials)
          .values(credential(await addUser(), { credentialId: row.credentialId })),
      ).rejects.toThrow();
    });

    it.each([
      ['an algorithm outside EdDSA, ES256 and RS256', { algorithm: -50 }],
      [
        'a credential id longer than the specification allows',
        { credentialId: new Uint8Array(1_024) },
      ],
      ['an empty credential id', { credentialId: new Uint8Array(0) }],
    ])('refuses %s', async (_case, overrides) => {
      await expect(
        db()
          .insert(webauthnCredentials)
          .values(credential(await addUser(), overrides)),
      ).rejects.toThrow();
    });

    it("deletes a person's passkeys with the person", async () => {
      const userId = await addUser();
      await db().insert(webauthnCredentials).values(credential(userId));

      await db().delete(users).where(eq(users.id, userId));

      await expect(
        db().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, userId)),
      ).resolves.toEqual([]);
    });

    it('holds a user handle of exactly 32 bytes, unique to one account', async () => {
      const handleBytes = new Uint8Array(randomBytes(32));
      const first = await addUser();
      await db().update(users).set({ webauthnUserHandle: handleBytes }).where(eq(users.id, first));

      await expect(
        db()
          .update(users)
          .set({ webauthnUserHandle: handleBytes })
          .where(eq(users.id, await addUser())),
      ).rejects.toThrow();
      await expect(
        db()
          .update(users)
          .set({ webauthnUserHandle: new Uint8Array(16) })
          .where(eq(users.id, await addUser())),
      ).rejects.toThrow();
    });
  });

  describe('the RP ID pin', () => {
    afterEach(clearPin);

    it('is unset until the first ceremony', async () => {
      await expect(new RpIdPinStore({ db: db(), settings: settingsWith() }).read()).resolves.toBe(
        null,
      );
    });

    it('settles on one host when replicas with different APP_URLs pin at once', async () => {
      const replicas = Array.from(
        { length: 12 },
        () => new RpIdPinStore({ db: db(), settings: settingsWith() }),
      );

      const results = await Promise.all(
        replicas.map((replica, index) =>
          replica.pinIfUnset(index % 2 === 0 ? 'desk.example.com' : 'admin.example.com'),
        ),
      );

      expect(new Set(results.map((result) => result.rpId)).size).toBe(1);
      expect(results[0]?.pinnedAt).toBeInstanceOf(Date);
      await expect(pinAudits()).resolves.toHaveLength(1);
    });

    it('keeps the first host when a later ceremony asks for another', async () => {
      const store = new RpIdPinStore({ db: db(), settings: settingsWith() });
      await store.pinIfUnset('desk.example.com');

      await expect(store.pinIfUnset('admin.example.com')).resolves.toMatchObject({
        rpId: 'desk.example.com',
      });
    });

    it('follows HD_AUTH_WEBAUTHN_RP_ID and writes nothing when the environment sets it', async () => {
      const store = new RpIdPinStore({
        db: db(),
        settings: settingsWith({ HD_AUTH_WEBAUTHN_RP_ID: 'desk.example.com' }),
      });

      await expect(store.pinIfUnset('admin.example.com')).resolves.toEqual({
        rpId: 'desk.example.com',
        pinnedAt: null,
      });
      await expect(
        new RpIdPinStore({ db: db(), settings: settingsWith() }).read(),
      ).resolves.toBeNull();
    });
  });

  describe('the ceremony store', () => {
    it('lets exactly one of many concurrent answers spend a ceremony', async () => {
      const store = new WebAuthnCeremonyStore(redis);
      const id = await store.begin({
        purpose: 'passwordless',
        challenge: 'C'.repeat(43),
        rpId: 'desk.example.com',
      });

      const spent = await Promise.all(
        Array.from({ length: 20 }, () => store.consume(id, 'passwordless')),
      );

      expect(spent.filter((ceremony) => ceremony !== null)).toHaveLength(1);
    });
  });

  describe('a passkey, end to end over the real stores', () => {
    afterEach(clearPin);

    it('registers, is stored, and signs in without a password', async () => {
      const service = new WebAuthnService({
        appUrl: APP_URL,
        ceremonies: new WebAuthnCeremonyStore(redis),
        pin: new RpIdPinStore({ db: db(), settings: settingsWith() }),
      });
      const userId = await addUser();
      const familyId = uuidv7();
      const authenticator = new SoftwareAuthenticator();

      const registration = await service.registrationOptions({
        user: { handle: new Uint8Array(randomBytes(32)), email: 'lina@example.com', name: 'Lina' },
        existing: [],
        binding: { userId, familyId },
      });
      const registered = await service.verifyRegistration({
        ceremonyId: registration.ceremonyId,
        binding: { userId, familyId },
        response: authenticator.register(registration.options, { origin: APP_URL }),
      });
      await db()
        .insert(webauthnCredentials)
        .values({ ...registered, userId, aaguid: registered.aaguid, name: 'Software key' });

      const sign = await service.authenticationOptions({ purpose: 'passwordless' });
      const check = await service.verifyAuthentication({
        ceremonyId: sign.ceremonyId,
        purpose: 'passwordless',
        response: authenticator.assert(sign.options, { origin: APP_URL }),
        findCredential: async (credentialId): Promise<StoredPasskey | undefined> => {
          const [row] = await db()
            .select()
            .from(webauthnCredentials)
            .where(eq(webauthnCredentials.credentialId, credentialId));
          return row;
        },
      });

      expect(check).toMatchObject({ ok: true, userVerified: true, credential: { userId } });
      await expect(
        new RpIdPinStore({ db: db(), settings: settingsWith() }).read(),
      ).resolves.toMatchObject({ rpId: 'desk.example.com' });
    });
  });
});
