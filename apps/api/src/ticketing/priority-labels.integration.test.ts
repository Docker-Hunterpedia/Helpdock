import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  brands,
  createDb,
  type Db,
  type DbHandle,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type { BrandSettings } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M1-02 against a real Postgres, over real sessions: the Priorities page's
 * `PUT /api/brands/:brandId/priority-labels`.
 *
 * What only the pieces together prove: the names persist in `brands.settings`
 * and come back with the brand, a cleared row removes its override, a duplicate
 * is refused at its field, who may write, that another brand's names are
 * neither visible nor writable, and that the audit row records the changed
 * values and nothing else.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 37).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M1-02 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface FieldRefusal {
  readonly error: { readonly code: string; readonly fields?: { path: string }[] };
}

describe.skipIf(!hasDocker)('editable priority labels', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let otherBrand: string;

  /** An Agent, a Team Leader, a Viewer of the brand, and an Admin of the other brand. */
  let sam: Person;
  let tia: Person;
  let vic: Person;
  let ola: Person;
  /** The install admin, an Admin of the brand. */
  let ada: Person;

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
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

  const call = <T>(
    method: 'GET' | 'PUT' | 'PATCH',
    path: string,
    who: Person,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url: path,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      })
      .then((response) => ({
        status: response.statusCode,
        body: (response.body === '' ? undefined : response.json()) as T,
      }));

  const brandPath = (): string => `/api/brands/${seeded.brandId}`;

  const labelsPath = (brandId: string): string => `/api/brands/${brandId}/priority-labels`;

  const storedLabels = async (
    brandId: string,
    who: Person,
  ): Promise<BrandSettings['priorityLabels']> =>
    (await call<{ settings: BrandSettings }>('GET', `/api/brands/${brandId}`, who)).body.settings
      .priorityLabels;

  const addPerson = async (db: Db, who: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }

    const id = uuidv7();
    const email = `${who}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name: who,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });

    return { id, email, token: '' };
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    app = await createApiApp({ runtime });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');
    tia = await addPerson(runtime.db, 'tia');
    vic = await addPerson(runtime.db, 'vic');
    ola = await addPerson(runtime.db, 'ola');

    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [] },
        { userId: tia.id, brandId: seeded.brandId, role: 'team_leader', departmentIds: null },
        { userId: vic.id, brandId: seeded.brandId, role: 'viewer', departmentIds: [] },
      ]),
    );

    otherBrand = uuidv7();
    await withSystem(runtime.db, otherBrand, async (tx) => {
      await tx.insert(brands).values({ id: otherBrand, name: 'Globex', prefix: 'GLX' });
      await tx
        .insert(userBrandRoles)
        .values({ userId: ola.id, brandId: otherBrand, role: 'admin', departmentIds: null });
    });

    for (const who of [ada, sam, tia, vic, ola]) {
      who.token = await signInForTest(app, {
        email: who.email,
        password: who === ada ? seeded.password : STAFF_PASSWORD,
      });
    }
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  /** Every case starts from a brand that has never been configured, and seeds what it needs. */
  beforeEach(async () => {
    for (const brandId of [seeded.brandId, otherBrand]) {
      await withSystem(runtime.db, brandId, (tx) =>
        tx.update(brands).set({ settings: {} }).where(eq(brands.id, brandId)),
      );
    }
  });

  const put = (brandId: string, who: Person, body: unknown) =>
    call<BrandSettings>('PUT', labelsPath(brandId), who, body);

  it('starts with no overrides', async () => {
    expect(await storedLabels(seeded.brandId, sam)).toEqual({});
  });

  it('persists the names, returns them, and every role that reads the brand receives them', async () => {
    const saved = await put(seeded.brandId, ada, {
      low: { en: '', ar: '' },
      high: { en: ' P2 ', ar: 'عالية جدًا' },
      urgent: { en: 'P1' },
    });

    expect(saved.status).toBe(200);
    expect(saved.body.priorityLabels).toEqual({
      high: { en: 'P2', ar: 'عالية جدًا' },
      urgent: { en: 'P1' },
    });
    for (const who of [sam, tia, vic]) {
      expect(await storedLabels(seeded.brandId, who)).toEqual(saved.body.priorityLabels);
    }
  });

  it('lets a Team Leader write, as ticketing:manage says', async () => {
    const saved = await put(seeded.brandId, tia, { high: { en: 'P2' } });

    expect(saved.status).toBe(200);
    expect(saved.body.priorityLabels).toEqual({ high: { en: 'P2' } });
  });

  it('removes an override when its row is cleared, and the other rows stay', async () => {
    await put(seeded.brandId, ada, { high: { en: 'P2' }, urgent: { en: 'P1', ar: 'حرجة' } });

    const cleared = await put(seeded.brandId, ada, { high: { en: '' }, urgent: { en: 'P1' } });

    expect(cleared.body.priorityLabels).toEqual({ urgent: { en: 'P1' } });
    expect(await storedLabels(seeded.brandId, ada)).toEqual({ urgent: { en: 'P1' } });
  });

  it('refuses a duplicate at the later of the two overrides, or at the override that meets a default', async () => {
    await put(seeded.brandId, ada, { urgent: { en: 'P1' } });

    const refused = await call<FieldRefusal>('PUT', labelsPath(seeded.brandId), ada, {
      high: { en: 'p1' },
      urgent: { en: 'P1' },
    });
    const againstDefault = await call<FieldRefusal>('PUT', labelsPath(seeded.brandId), ada, {
      low: { ar: 'عاجلة' },
    });
    const lookAlike = await call<FieldRefusal>('PUT', labelsPath(seeded.brandId), ada, {
      low: { ar: 'عــاجلة' },
    });

    expect(refused.status).toBe(400);
    expect(refused.body.error.fields?.map((field) => field.path)).toEqual(['urgent.en']);
    expect(againstDefault.status).toBe(400);
    expect(againstDefault.body.error.fields?.map((field) => field.path)).toEqual(['low.ar']);
    expect(lookAlike.status).toBe(400);
    expect(await storedLabels(seeded.brandId, ada)).toEqual({ urgent: { en: 'P1' } });
  });

  it('refuses a name that is too long, has a line break or is invisible, at its field', async () => {
    const long = await call<FieldRefusal>('PUT', labelsPath(seeded.brandId), ada, {
      low: { en: 'x'.repeat(25) },
    });
    const broken = await call<FieldRefusal>('PUT', labelsPath(seeded.brandId), ada, {
      medium: { ar: 'a\nb' },
    });
    const invisible = await call<FieldRefusal>('PUT', labelsPath(seeded.brandId), ada, {
      high: { en: 'High\u200b' },
    });

    expect(long.status).toBe(400);
    expect(long.body.error.fields?.[0]?.path).toBe('low.en');
    expect(broken.status).toBe(400);
    expect(broken.body.error.fields?.[0]?.path).toBe('medium.ar');
    expect(invisible.status).toBe(400);
    expect(invisible.body.error.fields?.[0]?.path).toBe('high.en');
  });

  it('refuses an Agent and a Viewer, who may read the names but not write them', async () => {
    await put(seeded.brandId, ada, { urgent: { en: 'P1' } });

    for (const who of [sam, vic]) {
      const refused = await put(seeded.brandId, who, { low: { en: 'Meh' } });
      expect(refused.status).toBe(403);
    }
    expect(await storedLabels(seeded.brandId, ada)).toEqual({ urgent: { en: 'P1' } });
  });

  it('keeps each brand’s names to itself', async () => {
    await put(seeded.brandId, ada, { urgent: { en: 'P1' } });

    const theirs = await put(otherBrand, ola, { urgent: { en: 'Fire' } });

    expect(theirs.status).toBe(200);
    expect(await storedLabels(otherBrand, ola)).toEqual({ urgent: { en: 'Fire' } });
    expect(await storedLabels(seeded.brandId, ada)).toEqual({ urgent: { en: 'P1' } });
    // Brand B's Admin can neither read nor write brand A's.
    expect((await call('GET', `/api/brands/${seeded.brandId}`, ola)).status).toBe(403);
    expect((await put(seeded.brandId, ola, { low: { en: 'Nope' } })).status).toBe(403);
    expect(await storedLabels(seeded.brandId, ada)).toEqual({ urgent: { en: 'P1' } });
  });

  describe('the other settings of the same column', () => {
    const settingsOf = async (): Promise<BrandSettings> =>
      (await call<{ settings: BrandSettings }>('GET', `/api/brands/${seeded.brandId}`, ada)).body
        .settings;

    it('are untouched by a labels write', async () => {
      await call('PATCH', `${brandPath()}/ticketing/reply-behaviour`, ada, {
        reopenPolicy: { kind: 'never' },
      });
      await call('PATCH', `${brandPath()}/ticketing/feedback`, ada, { csatEnabled: false });

      await put(seeded.brandId, ada, { high: { en: 'P2' } });

      expect(await settingsOf()).toMatchObject({
        reopenPolicy: { kind: 'never' },
        csatEnabled: false,
        priorityLabels: { high: { en: 'P2' } },
      });
    });

    it('write without touching the names', async () => {
      await put(seeded.brandId, ada, { high: { en: 'P2' } });

      await call('PATCH', `${brandPath()}/ticketing/reply-behaviour`, ada, {
        reopenPolicy: { kind: 'always' },
      });
      await call('PATCH', `${brandPath()}/ticketing/feedback`, ada, { timeTrackingEnabled: true });

      expect(await settingsOf()).toMatchObject({
        reopenPolicy: { kind: 'always' },
        timeTrackingEnabled: true,
        priorityLabels: { high: { en: 'P2' } },
      });
    });

    it('keep the names when the brand is patched without settings', async () => {
      await put(seeded.brandId, ada, { high: { en: 'P2' } });

      const patched = await call('PATCH', brandPath(), ada, { name: 'Renamed brand' });

      expect(patched.status).toBe(200);
      expect((await settingsOf()).priorityLabels).toEqual({ high: { en: 'P2' } });
    });

    it('survive stored names that stopped being valid by reading as none, not as all defaults', async () => {
      await call('PATCH', `${brandPath()}/ticketing/reply-behaviour`, ada, {
        reopenPolicy: { kind: 'never' },
      });
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(brands)
          .set({
            settings: sql`${brands.settings} || '{"priorityLabels":{"high":{"en":"Low"}}}'::jsonb`,
          })
          .where(eq(brands.id, seeded.brandId)),
      );

      expect(await settingsOf()).toMatchObject({
        reopenPolicy: { kind: 'never' },
        priorityLabels: {},
      });
    });
  });

  it('audits only the names that changed, with their values, and nothing for a repeat', async () => {
    const auditRows = () =>
      withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ meta: auditLog.meta, actorId: auditLog.actorId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'brand.priority_labels.updated'),
              eq(auditLog.targetId, seeded.brandId),
            ),
          )
          .orderBy(auditLog.createdAt),
      );
    await put(seeded.brandId, ada, { urgent: { en: 'P1' } });
    const body = { urgent: { en: 'P1', ar: 'حرجة' } };

    await put(seeded.brandId, ada, body);
    const afterRename = await auditRows();
    await put(seeded.brandId, ada, body);
    const afterRepeat = await auditRows();

    expect(afterRepeat).toHaveLength(afterRename.length);
    expect(afterRepeat.at(-1)?.meta).toEqual({
      before: { urgent: { ar: null } },
      after: { urgent: { ar: 'حرجة' } },
    });
    expect(afterRepeat.at(-1)?.actorId).toBe(ada.id);
  });
});
