import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Env } from '@helpdock/config';
import { createDb, type DbHandle, users } from '@helpdock/db';
import { PROFILE_PHOTO_MAX_BYTES, type Profile } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROFILE_PHOTO_RULE } from '../auth/rate-limit.js';
import { hashSubject, rateLimitKey } from '../auth/redis-keys.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { FakeStorage } from '../testing/media.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { AccountService } from './account.service.js';
import { anonymisedEmail } from './anonymise.js';

/**
 * Your account's profile for customers (M14-12) over HTTP, against a real
 * Postgres and Redis and a bucket on the filesystem: the fields and their
 * normalisation, the photo's gates and what is actually stored, and what an
 * account's deletion leaves of it. `users` is a global table, so there is no
 * tenant row to add to the isolation suite; the point here is that one person's
 * photo is only ever reachable through their own session.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');
const APP_URL = 'https://support.example.com';

const hasDocker = await dockerAvailable();
if (!hasDocker) {
  process.stderr.write(
    'Skipping the profile integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the profile for customers', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let bucketDir: string;
  let storage: FakeStorage;
  let token: string;

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
      ADMIN_DIST_DIR: 'apps/admin/dist',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const json = (method: 'GET' | 'PATCH' | 'DELETE', url: string, body?: unknown, auth = token) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${auth}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

  /** A multipart upload as a browser's `FormData` writes it. */
  const upload = async (
    file: { bytes: Uint8Array; type: string; name?: string } | null,
    { field = 'photo', auth = token }: { field?: string; auth?: string | null } = {},
  ) => {
    const form = new FormData();
    if (file !== null) {
      form.append(field, new File([file.bytes], file.name ?? 'me.png', { type: file.type }));
    }
    const request = new Request('http://upload.test', { method: 'POST', body: form });

    return app.inject({
      method: 'POST',
      url: '/api/me/profile/photo',
      headers: {
        'content-type': request.headers.get('content-type') ?? '',
        ...(auth === null ? {} : { authorization: `Bearer ${auth}` }),
      },
      payload: Buffer.from(await request.arrayBuffer()),
    });
  };

  const png = (edge = 120) =>
    sharp({ create: { width: edge, height: edge, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();

  const row = async () => {
    const [found] = await runtime.db.select().from(users).where(eq(users.id, seeded.userId));
    return found;
  };

  const profile = async (): Promise<Profile> => (await json('GET', '/api/me/profile')).json();

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    bucketDir = await mkdtemp(path.join(tmpdir(), 'helpdock-profile-bucket-'));
    storage = new FakeStorage(bucketDir);

    const env = envFor();
    runtime = await createRuntime({
      env,
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
        destination: { write: () => {} },
      }),
    });
    app = await createApiApp({ runtime, objectStorage: storage });
    seeded = await seedDevInstall({ db: runtime.db, env });
    token = await signInForTest(app, { email: seeded.email, password: seeded.password });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
    if (bucketDir !== undefined) {
      await rm(bucketDir, { recursive: true, force: true });
    }
  });

  describe('the fields', () => {
    it('starts with no public name, and shows the first name as what customers see', async () => {
      const initial = await profile();

      expect(initial).toMatchObject({
        publicName: null,
        displayName: initial.name.split(' ')[0],
        jobTitleEn: null,
        jobTitleAr: null,
        phone: null,
        timeZone: null,
        photo: null,
      });
    });

    it('saves the public name, both titles, the zone and the phone in E.164', async () => {
      const response = await json('PATCH', '/api/me/profile', {
        publicName: 'Lina H',
        jobTitleEn: 'Billing specialist',
        jobTitleAr: 'أخصائية الفوترة',
        phone: '٠٠966 55 123 4567',
        timeZone: 'Asia/Riyadh',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        publicName: 'Lina H',
        displayName: 'Lina H',
        jobTitleEn: 'Billing specialist',
        jobTitleAr: 'أخصائية الفوترة',
        phone: '+966551234567',
        timeZone: 'Asia/Riyadh',
      });
      expect(await row()).toMatchObject({
        publicName: 'Lina H',
        publicPhone: '+966551234567',
        timeZone: 'Asia/Riyadh',
      });
    });

    it('keeps what a later request leaves out, and clears what it sets to null', async () => {
      await json('PATCH', '/api/me/profile', { jobTitleEn: 'Agent' });
      const response = await json('PATCH', '/api/me/profile', { publicName: null });

      expect(response.json()).toMatchObject({
        publicName: null,
        displayName: expect.not.stringContaining('H'),
        jobTitleEn: 'Agent',
        phone: '+966551234567',
      });
    });

    it('refuses a phone that is not international, and changes nothing else in that request', async () => {
      const before = await profile();

      const response = await json('PATCH', '/api/me/profile', {
        jobTitleEn: 'Would be lost',
        phone: '0551234567',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { staff: { reason: 'invalid-phone' } } });
      expect((await profile()).jobTitleEn).toBe(before.jobTitleEn);
    });

    it.each([
      ['an unknown zone', { timeZone: 'Mars/Olympus' }],
      ['a name over the cap', { publicName: 'x'.repeat(61) }],
      ['an empty request', {}],
    ])('refuses %s', async (_name, body) => {
      expect((await json('PATCH', '/api/me/profile', body)).statusCode).toBe(400);
    });

    it('answers nobody without a session', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/me/profile' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('the photo', () => {
    it('stores a 256 and a 64 px WebP under the install prefix, and answers with presigned URLs', async () => {
      const response = await upload({ bytes: await png(500), type: 'image/png' });

      expect(response.statusCode).toBe(201);
      const { photo } = response.json() as Profile;
      expect(photo?.small).toMatch(/^https:\/\/bucket\.test\//);
      expect(decodeURIComponent(photo?.large ?? '')).toContain(`install/users/${seeded.userId}/`);

      const folder = (await row())?.photoKey ?? '';
      expect(folder).toMatch(new RegExp(`^install/users/${seeded.userId}/[0-9a-f-]{36}/$`));
      const large = await sharp(await storage.read(`${folder}256.webp`)).metadata();
      const small = await sharp(await storage.read(`${folder}64.webp`)).metadata();
      expect([large.format, large.width, large.height]).toEqual(['webp', 256, 256]);
      expect([small.format, small.width, small.height]).toEqual(['webp', 64, 64]);
    });

    it('never stores the original or any metadata it carried', async () => {
      const tagged = await sharp({
        create: { width: 100, height: 100, channels: 3, background: '#aa3333' },
      })
        .jpeg()
        .withExif({ IFD0: { Copyright: 'location-bearing' }, IFD3: { GPSLatitudeRef: 'N' } })
        .toBuffer();

      await upload({ bytes: tagged, type: 'image/jpeg' });
      const folder = (await row())?.photoKey ?? '';

      for (const name of ['256.webp', '64.webp']) {
        const stored = await storage.read(`${folder}${name}`);
        expect((await sharp(stored).metadata()).exif).toBeUndefined();
        expect(stored.includes(Buffer.from('location-bearing'))).toBe(false);
      }
      expect(storage.removed.some((key) => key.includes('original'))).toBe(false);
    });

    it('replaces the photo and deletes the objects of the one it replaced', async () => {
      const before = (await row())?.photoKey ?? '';
      storage.removed.length = 0;

      await upload({ bytes: await png(), type: 'image/png' });

      const after = (await row())?.photoKey ?? '';
      expect(after).not.toBe(before);
      expect(storage.removed).toEqual([`${before}256.webp`, `${before}64.webp`]);
    });

    it('keeps the old folder when the request rolls back, and the row pointing at it', async () => {
      await upload({ bytes: await png(), type: 'image/png' });
      const kept = (await row())?.photoKey ?? '';
      storage.removed.length = 0;

      // The upload itself runs inside the request's transaction; forcing one
      // that replaces the photo and then fails proves the deletion of the
      // folder it replaced waits for the commit (M14-12 review b).
      const context = new RequestContext({
        requestId: 'rollback-test',
        method: 'POST',
        path: '/api/me/profile/photo',
      });
      await expect(
        runInRequestContext(context, () =>
          runtime.db.transaction(async (tx) => {
            await app.get(AccountService).setPhoto(tx, seeded.userId, await png(), 'image/png');
            throw new Error('roll the request back');
          }),
        ),
      ).rejects.toThrow('roll the request back');

      expect(storage.removed).toEqual([]);
      expect(await storage.head(`${kept}256.webp`)).toBeDefined();
      expect(await storage.head(`${kept}64.webp`)).toBeDefined();
      expect((await row())?.photoKey).toBe(kept);
    });

    it.each([
      [
        'text posing as a PNG',
        async () => Buffer.from('<script>alert(1)</script>'),
        'image/png',
        'photo-unsupported-type',
      ],
      ['a PNG declared as a JPEG', () => png(), 'image/jpeg', 'photo-unsupported-type'],
      [
        'an SVG',
        async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'image/svg+xml',
        'photo-unsupported-type',
      ],
      ['a GIF', async () => Buffer.from('GIF89a'), 'image/gif', 'photo-unsupported-type'],
      [
        'a truncated PNG',
        async () => (await png(300)).subarray(0, 60),
        'image/png',
        'photo-unreadable',
      ],
    ])('refuses %s and keeps the photo it has', async (_name, build, type, reason) => {
      const kept = (await row())?.photoKey;

      const response = await upload({ bytes: await build(), type });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { staff: { reason } } });
      expect((await row())?.photoKey).toBe(kept);
    });

    it('refuses a photo over 5 MB', async () => {
      const kept = (await row())?.photoKey;
      const head = await png();
      const big = Buffer.concat([head, Buffer.alloc(PROFILE_PHOTO_MAX_BYTES, 1)]);

      const response = await upload({ bytes: big, type: 'image/png' });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { staff: { reason: 'photo-too-large' } } });
      expect((await row())?.photoKey).toBe(kept);
    });

    it('refuses a form with no photo in it, and a body that is not a form', async () => {
      const wrongField = await upload(
        { bytes: await png(), type: 'image/png' },
        { field: 'avatar' },
      );
      const noFile = await upload(null);
      const plain = await app.inject({
        method: 'POST',
        url: '/api/me/profile/photo',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: '{}',
      });

      expect(wrongField.json()).toMatchObject({ error: { staff: { reason: 'photo-missing' } } });
      expect(noFile.json()).toMatchObject({ error: { staff: { reason: 'photo-missing' } } });
      expect(plain.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('accepts no upload without a session', async () => {
      expect(
        (await upload({ bytes: await png(), type: 'image/png' }, { auth: null })).statusCode,
      ).toBe(401);
    });

    it('removes the photo and its objects', async () => {
      const folder = (await row())?.photoKey ?? '';
      storage.removed.length = 0;

      const response = await json('DELETE', '/api/me/profile/photo');

      expect(response.statusCode).toBe(200);
      expect((response.json() as Profile).photo).toBeNull();
      expect((await row())?.photoKey).toBeNull();
      expect(storage.removed).toEqual([`${folder}256.webp`, `${folder}64.webp`]);
    });

    it('answers 429 once the account has uploaded ten photos in a quarter-hour', async () => {
      await runtime.redis.del(rateLimitKey('profile-photo', hashSubject(seeded.userId)));

      const small = await png(40);
      const allowed = await Promise.all(
        Array.from({ length: PROFILE_PHOTO_RULE.limit }, () =>
          upload({ bytes: small, type: 'image/png' }),
        ),
      );
      for (const response of allowed) {
        expect(response.statusCode).toBe(201);
      }

      const refused = await upload({ bytes: small, type: 'image/png' });
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        error: { staff: { reason: 'photo-rate-limited' } },
      });
      // The spent budget kept nothing: the photo it had is untouched.
      expect((await row())?.photoKey).not.toBeNull();
    });
  });

  describe('deleting an account', () => {
    it('drops the profile, the signature and the photo with the identity', async () => {
      const gone = await runtime.db
        .insert(users)
        .values({
          email: 'gone@example.com',
          name: 'Gone Person',
          status: 'deactivated',
          publicName: 'Gone',
          jobTitleEn: 'Agent',
          publicPhone: '+966551234567',
          timeZone: 'Asia/Riyadh',
          signatureEn: 'Gone Person',
          photoKey: 'install/users/gone/photo/',
        })
        .returning({ id: users.id });
      const id = gone[0]?.id ?? '';
      storage.removed.length = 0;

      const response = await json('DELETE', `/api/install/staff/${id}`);

      expect(response.statusCode).toBe(204);
      const [after] = await runtime.db.select().from(users).where(eq(users.id, id));
      expect(after).toMatchObject({
        email: anonymisedEmail(id),
        publicName: null,
        jobTitleEn: null,
        jobTitleAr: null,
        publicPhone: null,
        timeZone: null,
        signatureEn: null,
        signatureAr: null,
        photoKey: null,
      });
      expect(storage.removed).toEqual([
        'install/users/gone/photo/256.webp',
        'install/users/gone/photo/64.webp',
      ]);
    });
  });
});
