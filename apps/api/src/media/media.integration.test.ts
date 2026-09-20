import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  attachments,
  brands,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  seedBrandStatuses,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';

import type {
  Attachment,
  AttachmentDownload,
  AttachmentPresignResponse,
  TicketDetail,
  TicketMessage,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { fakeScanner, fakeTools, silentJobLogger } from '../testing/media.js';
import { createMediaProcessor } from './process.job.js';
import { createS3Client, S3ObjectStorage } from './storage.js';

/**
 * M1-10 against a real Postgres, a real Redis and a real MinIO.
 *
 * The unit suites prove each piece decides correctly. This proves the things
 * that only exist when they are together:
 *
 * 1. **A presigned PUT really works, and really is bound.** The URL the api
 *    issues is signed by the AWS SDK and verified by MinIO, so "one object,
 *    this size, this type, five minutes" is checked by something that is not
 *    this codebase.
 * 2. **Authorisation is the parent ticket's.** An Agent of another department
 *    cannot presign, confirm, download or delete — and the download endpoint in
 *    particular never issues a URL for a ticket they cannot read
 *    (DOMAIN-RULES §4.5).
 * 3. **The confirm and its job commit together** (DOMAIN-RULES §6): a rolled
 *    back confirm leaves no outbox row.
 * 4. **The worker turns real bytes into real variants**, and a real JPEG with
 *    real EXIF comes out as a WebP without it.
 *
 * ffmpeg is *not* required: the audio and video paths are exercised with a
 * double here, because a worker without ffmpeg is a supported deployment
 * (`FFMPEG_PATH` is optional) and the argument construction is unit-tested. The
 * ffmpeg-dependent assertions live in `media-ffmpeg.integration.test.ts`, which
 * skips itself when the binary is absent.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
/**
 * MinIO from **Quay**, pinned, and not `minio/minio` from Docker Hub.
 *
 * A GitHub-hosted runner shares its address with everybody else's, so an
 * anonymous Docker Hub pull of an image the job does not already have is
 * rate-limited — it comes back as `pull access denied for minio/minio`, which
 * fails this suite for a reason that has nothing to do with the code. Quay is
 * MinIO's own registry and does not meter anonymous pulls. `docker-compose.yml`
 * names the same image for the same reason.
 */
const MINIO_IMAGE = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';
const BUCKET = 'helpdock-test';
const S3_KEY = 'helpdock';
const S3_SECRET = 'helpdock-secret';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 23).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 180_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the media integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('the media pipeline', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let minio: StartedTestContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let storage: S3ObjectStorage;
  let s3Endpoint: string;

  /** One brand, two departments, one agent confined to each. */
  let support: string;
  let billing: string;
  let sam: Person;
  let bo: Person;
  let ada: Person;

  let jpegWithExif: Buffer;

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: postgres
        .getConnectionUri()
        .replace(/\/\/[^@]+@/, `//helpdock_app:${APP_ROLE_PASSWORD}@`)
        .replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      DATABASE_MIGRATION_URL: postgres.getConnectionUri().replace(/\/[^/?]+(\?|$)/, '/helpdock$1'),
      REDIS_URL: redisContainer.getConnectionUrl(),
      S3_ENDPOINT: s3Endpoint,
      S3_REGION: 'us-east-1',
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: S3_KEY,
      S3_SECRET_ACCESS_KEY: S3_SECRET,
      // MinIO addresses a bucket as a path; virtual-host style needs DNS.
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const call = <T>(
    method: 'GET' | 'POST' | 'DELETE',
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

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password }),
    });

    const body = response.json() as { kind: string; accessToken?: string };
    if (body.kind !== 'session' || body.accessToken === undefined) {
      throw new Error(`sign-in did not produce a session: ${response.body}`);
    }

    return body.accessToken;
  };

  const attachmentsPath = (ticketId: string, brandId = seeded.brandId) =>
    `/api/brands/${brandId}/tickets/${ticketId}/attachments`;

  const createTicket = async (who: Person, departmentId = support): Promise<TicketDetail> => {
    const response = await call<TicketDetail>(
      'POST',
      `/api/brands/${seeded.brandId}/tickets`,
      who,
      {
        subject: 'Screenshot attached',
        bodyHtml: '<p>See attached.</p>',
        departmentId,
      },
    );

    expect(response.status).toBe(201);
    return response.body;
  };

  /** Presign, PUT to MinIO for real, confirm. The whole client-side dance. */
  const upload = async (
    who: Person,
    ticketId: string,
    options: {
      bytes: Uint8Array;
      kind?: string;
      mime?: string;
      fileName?: string;
      /** Send more bytes than were signed for, to prove the URL is bound. */
      overrun?: boolean;
    },
  ) => {
    const presign = await call<AttachmentPresignResponse>(
      'POST',
      `${attachmentsPath(ticketId)}/presign`,
      who,
      {
        kind: options.kind ?? 'image',
        mime: options.mime ?? 'image/png',
        size: options.bytes.byteLength,
        fileName: options.fileName ?? 'shot.png',
      },
    );

    if (presign.status !== 201) {
      return { presign, put: undefined, confirm: undefined };
    }

    const body =
      options.overrun === true ? new Uint8Array(options.bytes.byteLength + 1) : options.bytes;
    const put = await fetch(presign.body.url, {
      method: 'PUT',
      headers: {
        'content-type': presign.body.headers['content-type'] ?? 'application/octet-stream',
      },
      body,
    });

    const confirm = await call<Attachment>(
      'POST',
      `${attachmentsPath(ticketId)}/${presign.body.attachmentId}/confirm`,
      who,
    );

    return { presign, put, confirm };
  };

  /** What the worker does, in this process, with the doubles for ffmpeg. */
  const runProcessor = async (attachmentId: string, scan?: 'clean' | 'infected' | 'error') => {
    const processor = createMediaProcessor({
      storage,
      tools: fakeTools(),
      scanner: scan === undefined ? undefined : fakeScanner(scan),
    });

    return withSystem(runtime.db, seeded.brandId, (tx) =>
      processor.run({
        payload: { brandId: seeded.brandId, attachmentId },
        tx,
        log: silentJobLogger,
      }),
    );
  };

  /**
   * Every outbox row this brand has written and not yet published. The relay
   * and the dispatcher are proved in `packages/jobs`; what this suite asserts
   * is that a row exists, with the payload the change it describes produced.
   */
  const unpublished = () =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`),
    );

  /** Stamps everything published, so a later assertion sees only its own rows. */
  const clearOutbox = async (): Promise<void> => {
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.update(outbox).set({ publishedAt: new Date() }).where(sql`${outbox.publishedAt} is null`),
    );
  };

  const addPerson = async (db: Db, name: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }

    const id = uuidv7();
    const email = `${name}-${id}@helpdock.test`;
    await db.insert(users).values({
      id,
      email,
      name,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(AGENT_PASSWORD),
    });

    return { id, email, token: '' };
  };

  beforeAll(async () => {
    [postgres, redisContainer, minio] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new GenericContainer(MINIO_IMAGE)
        .withCommand(['server', '/data'])
        .withEnvironment({ MINIO_ROOT_USER: S3_KEY, MINIO_ROOT_PASSWORD: S3_SECRET })
        .withExposedPorts(9000)
        // MinIO answers `/minio/health/live` as soon as it is serving; the
        // bucket is created below, because the image has no "create on write".
        .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
        .withStartupTimeout(CONTAINER_STARTUP_MS)
        .start(),
    ]);

    s3Endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;

    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });

    const client = createS3Client(envFor());
    // The one thing Compose's `mc` sidecar does in a real deployment.
    await client.send(
      new (await import('@aws-sdk/client-s3')).CreateBucketCommand({ Bucket: BUCKET }),
    );
    storage = new S3ObjectStorage(client, BUCKET);

    app = await createApiApp({ runtime, objectStorage: storage });
    await app.listen({ port: 0, host: '127.0.0.1' });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');
    bo = await addPerson(runtime.db, 'bo');

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      await seedBrandStatuses(tx, seeded.brandId);
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });

      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
      ]);
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, AGENT_PASSWORD);
    bo.token = await signIn(bo.email, AGENT_PASSWORD);

    jpegWithExif = await sharp({
      create: { width: 1_200, height: 800, channels: 3, background: '#4c6ef5' },
    })
      .withExifMerge({ IFD0: { Copyright: 'Helpdock test', Artist: 'somebody' } })
      .jpeg()
      .toBuffer();
  }, 400_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop(), minio?.stop()]);
  });

  const png = async (size = 64): Promise<Buffer> =>
    sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
      .png()
      .toBuffer();

  // ------------------------------------------------------------------ presign

  describe('presign', () => {
    it('refuses a kind the brand has switched off', async () => {
      const ticket = await createTicket(sam);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(brands)
          .set({
            settings: {
              contentPolicy: {
                video: { enabled: false, maxBytes: 1_000, allowedMime: ['video/mp4'] },
              },
            },
          })
          .where(eq(brands.id, seeded.brandId)),
      );

      const response = await call('POST', `${attachmentsPath(ticket.ticket.id)}/presign`, sam, {
        kind: 'video',
        mime: 'video/mp4',
        size: 1_000,
        fileName: 'clip.mp4',
      });

      expect(response.status).toBe(400);

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.update(brands).set({ settings: {} }).where(eq(brands.id, seeded.brandId)),
      );
    });

    it('refuses a file larger than the brand allows, before a byte is sent', async () => {
      const ticket = await createTicket(sam);

      const response = await call('POST', `${attachmentsPath(ticket.ticket.id)}/presign`, sam, {
        kind: 'image',
        mime: 'image/png',
        size: 20 * 1_048_576,
        fileName: 'huge.png',
      });

      expect(response.status).toBe(413);
    });

    it('refuses a type the brand does not allow', async () => {
      const ticket = await createTicket(sam);

      const response = await call('POST', `${attachmentsPath(ticket.ticket.id)}/presign`, sam, {
        kind: 'image',
        mime: 'image/svg+xml',
        size: 100,
        fileName: 'logo.svg',
      });

      expect(response.status).toBe(415);
    });

    it('refuses a ticket in another department, and says no more than "no such ticket"', async () => {
      const ticket = await createTicket(sam);

      const response = await call('POST', `${attachmentsPath(ticket.ticket.id)}/presign`, bo, {
        kind: 'image',
        mime: 'image/png',
        size: 100,
        fileName: 'shot.png',
      });

      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(support);
    });

    it('leaves a pending row with the name folded and no path in it', async () => {
      const ticket = await createTicket(sam);
      const bytes = await png();

      const presign = await call<AttachmentPresignResponse>(
        'POST',
        `${attachmentsPath(ticket.ticket.id)}/presign`,
        sam,
        {
          kind: 'image',
          mime: 'image/png',
          size: bytes.byteLength,
          fileName: '../../etc/passwd.png',
        },
      );

      expect(presign.status).toBe(201);

      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(attachments).where(eq(attachments.id, presign.body.attachmentId)),
      );

      expect(row?.status).toBe('pending');
      expect(row?.originalName).toBe('passwd.png');
      // Every segment of the key is a uuid this api generated.
      expect(row?.s3Key).toBe(
        `brands/${seeded.brandId}/tickets/${ticket.ticket.id}/${presign.body.attachmentId}/original`,
      );
    });
  });

  // -------------------------------------------------------------------- PUT

  describe('the presigned URL', () => {
    it('accepts exactly the object it was signed for', async () => {
      const ticket = await createTicket(sam);
      const { put, confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });

      expect(put?.status).toBe(200);
      expect(confirm?.status).toBe(201);
      expect(confirm?.body.status).toBe('processing');
    });

    it('refuses one byte more than was asked for', async () => {
      // `content-length` is signed, so MinIO recomputes the signature over the
      // request that actually arrived and refuses. Nothing is stored, and the
      // confirm that follows finds no object.
      const ticket = await createTicket(sam);
      const { put, confirm } = await upload(sam, ticket.ticket.id, {
        bytes: await png(),
        overrun: true,
      });

      expect(put?.status).toBe(403);
      expect(confirm?.status).toBe(201);
      expect(confirm?.body.status).toBe('rejected');
      expect(confirm?.body.rejectReason).toBe('object_missing');
    });
  });

  // ---------------------------------------------------------------- confirm

  describe('confirm', () => {
    it('enqueues the job in the same transaction, and nothing when it rolls back', async () => {
      const ticket = await createTicket(sam);

      // A transaction that writes the status change and the outbox row and then
      // throws must leave neither (DOMAIN-RULES §6).
      const before = await unpublished();
      await expect(
        withSystem(runtime.db, seeded.brandId, async (tx) => {
          await tx.insert(outbox).values({
            brandId: seeded.brandId,
            event: 'attachment.uploaded',
            payload: { attachmentId: uuidv7(), ticketId: ticket.ticket.id },
          });
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');

      expect((await unpublished()).length).toBe(before.length);
    });

    it('writes one attachment.uploaded row, and one only however often it is retried', async () => {
      const ticket = await createTicket(sam);
      await clearOutbox();

      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      expect(confirm?.status).toBe(201);

      const again = await call<Attachment>(
        'POST',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}/confirm`,
        sam,
      );

      expect(again.status).toBe(201);
      const rows = await unpublished();
      expect(rows.filter((row) => row.event === 'attachment.uploaded')).toHaveLength(1);
    });

    it('marks the row rejected when no object was uploaded, and the row survives', async () => {
      const ticket = await createTicket(sam);
      const bytes = await png();

      const presign = await call<AttachmentPresignResponse>(
        'POST',
        `${attachmentsPath(ticket.ticket.id)}/presign`,
        sam,
        { kind: 'image', mime: 'image/png', size: bytes.byteLength, fileName: 'shot.png' },
      );

      const confirm = await call<Attachment>(
        'POST',
        `${attachmentsPath(ticket.ticket.id)}/${presign.body.attachmentId}/confirm`,
        sam,
      );

      // Answered rather than thrown: an exception would roll the rejection back
      // with the request's transaction and leave the row at `pending` with
      // nothing saying why.
      expect(confirm.status).toBe(201);
      expect(confirm.body.status).toBe('rejected');
      expect(confirm.body.rejectReason).toBe('object_missing');

      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(attachments).where(eq(attachments.id, presign.body.attachmentId)),
      );
      expect(row?.status).toBe('rejected');
      expect(row?.rejectReason).toBe('object_missing');
    });
  });

  // ----------------------------------------------------------------- worker

  describe('the worker', () => {
    it('turns a JPEG with EXIF into a WebP without it, and two thumbnails', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, {
        bytes: jpegWithExif,
        mime: 'image/jpeg',
        fileName: 'holiday.jpg',
      });

      const outcome = await runProcessor(confirm?.body.id ?? '');
      expect(outcome.status).toBe('ready');

      const download = await call<AttachmentDownload>(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=webp`,
        sam,
      );

      expect(download.status).toBe(200);
      expect(Object.keys(download.body.attachment.variants).sort()).toEqual([
        'thumb320',
        'thumb960',
        'webp',
      ]);

      const served = await fetch(download.body.url);
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('image/webp');
      // An image this install encoded is the one thing served inline.
      expect(served.headers.get('content-disposition')).toContain('inline');

      const metadata = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.exif).toBeUndefined();
    });

    it('rejects an object past the cap without taking the worker down with it', async () => {
      // The cap trips mid-stream, which rejects the pump *and* the sink. An
      // unobserved second rejection is an unhandled rejection, and Node ends
      // the process on one — so the assertion that matters is not only the
      // reason but that this suite is still running afterwards.
      const ticket = await createTicket(sam);
      const big = await png(600);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: big });

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(brands)
          .set({
            settings: {
              contentPolicy: {
                image: { enabled: true, maxBytes: 512, allowedMime: ['image/png'] },
              },
            },
          })
          .where(eq(brands.id, seeded.brandId)),
      );

      const rejections: unknown[] = [];
      const record = (reason: unknown): void => void rejections.push(reason);
      global.process.on('unhandledRejection', record);
      try {
        const outcome = await runProcessor(confirm?.body.id ?? '');
        expect(outcome).toEqual({ status: 'rejected', reason: 'too_large' });
        // One turn of the loop is when an unhandled rejection would surface.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toEqual([]);
      } finally {
        global.process.off('unhandledRejection', record);
        await withSystem(runtime.db, seeded.brandId, (tx) =>
          tx.update(brands).set({ settings: {} }).where(eq(brands.id, seeded.brandId)),
        );
      }
    });

    it('rejects an upload whose bytes are not what it declared', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, {
        bytes: jpegWithExif,
        mime: 'image/png',
      });

      const outcome = await runProcessor(confirm?.body.id ?? '');

      expect(outcome).toEqual({ status: 'rejected', reason: 'mime_mismatch' });
    });

    it('serves a file as a download and never inline', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, {
        bytes: Buffer.from('%PDF-1.7\n% helpdock\n'),
        kind: 'file',
        mime: 'application/pdf',
        fileName: 'invoice.pdf',
      });

      await runProcessor(confirm?.body.id ?? '');

      const download = await call<AttachmentDownload>(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=original`,
        sam,
      );

      const served = await fetch(download.body.url);
      expect(served.headers.get('content-disposition')).toContain('attachment');
      expect(served.headers.get('content-disposition')).toContain('invoice.pdf');
    });

    it('deletes an infected object and keeps the row as the record', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, {
        bytes: Buffer.from('%PDF-1.7 eicar'),
        kind: 'file',
        mime: 'application/pdf',
      });

      const outcome = await runProcessor(confirm?.body.id ?? '', 'infected');
      expect(outcome.status).toBe('infected');

      const download = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}`,
        sam,
      );
      expect(download.status).toBe(409);
    });

    it('emits attachment.ready on the ticket room through the outbox', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const rows = await unpublished();
      const ready = rows.find(
        (row) => row.event === 'attachment.ready' && row.payload.attachmentId === confirm?.body.id,
      );

      expect(ready?.payload).toMatchObject({
        attachmentId: confirm?.body.id,
        ticketId: ticket.ticket.id,
        status: 'ready',
      });
    });
  });

  // --------------------------------------------------------------- download

  describe('download', () => {
    it('refuses while the row is still being processed', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });

      const download = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}`,
        sam,
      );

      expect(download.status).toBe(409);
    });

    it('refuses an agent in another department, so no URL is ever issued', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const download = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=webp`,
        bo,
      );

      // DOMAIN-RULES §4.5. The row is invisible to the policy, so there is
      // nothing to sign — not a refusal after signing.
      expect(download.status).toBe(404);
    });

    it('refuses a variant the row does not have, including a discarded original', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const original = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=original`,
        sam,
      );
      const poster = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=poster`,
        sam,
      );

      expect(original.status).toBe(404);
      expect(poster.status).toBe(404);
    });

    it('refuses an attachment of another ticket, even one the caller may read', async () => {
      const mine = await createTicket(sam);
      const other = await createTicket(sam);
      const { confirm } = await upload(sam, mine.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const response = await call(
        'GET',
        `${attachmentsPath(other.ticket.id)}/${confirm?.body.id}?variant=webp`,
        sam,
      );

      expect(response.status).toBe(404);
    });

    it('goes out of reach when the ticket is soft-deleted (M1-08)', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const before = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=webp`,
        sam,
      );
      expect(before.status).toBe(200);

      // `brand:manage`, so the install admin rather than the agent.
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/brands/${seeded.brandId}/tickets/${ticket.ticket.id}`,
        headers: { authorization: `Bearer ${ada.token}` },
      });
      expect(deleted.statusCode).toBe(204);

      // The attachment row survives a soft delete, so without the join in
      // `find` a presigned download would still be issued for a ticket the
      // desk has deleted.
      const after = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=webp`,
        sam,
      );
      expect(after.status).toBe(404);
    });

    it('never puts the object key in the response', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const download = await call<AttachmentDownload>(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}?variant=thumb320`,
        sam,
      );

      expect(JSON.stringify(download.body.attachment)).not.toContain('s3Key');
      expect(JSON.stringify(download.body.attachment)).not.toContain('uploaderId');
    });
  });

  // ----------------------------------------------------------------- delete

  describe('delete', () => {
    it('discards an upload the composer abandoned before confirming it', async () => {
      const ticket = await createTicket(sam);
      const bytes = await png();
      const presign = await call<AttachmentPresignResponse>(
        'POST',
        `${attachmentsPath(ticket.ticket.id)}/presign`,
        sam,
        { kind: 'image', mime: 'image/png', size: bytes.byteLength, fileName: 'shot.png' },
      );

      const removed = await call(
        'DELETE',
        `${attachmentsPath(ticket.ticket.id)}/${presign.body.attachmentId}`,
        sam,
      );

      expect(removed.status).toBe(204);
      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(attachments).where(eq(attachments.id, presign.body.attachmentId)),
      );
      expect(rows).toHaveLength(0);
    });

    it('refuses one that is being processed, because a job is about to read it', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });

      const removed = await call(
        'DELETE',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}`,
        sam,
      );

      expect(removed.status).toBe(409);
    });

    it('refuses to delete one that has been processed', async () => {
      const ticket = await createTicket(sam);
      const { confirm } = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(confirm?.body.id ?? '');

      const removed = await call(
        'DELETE',
        `${attachmentsPath(ticket.ticket.id)}/${confirm?.body.id}`,
        sam,
      );

      // A `ready` attachment belongs to a message and goes with the ticket
      // (DOMAIN-RULES §11).
      expect(removed.status).toBe(409);
    });

    it('refuses an agent in another department', async () => {
      const ticket = await createTicket(sam);
      const bytes = await png();
      const presign = await call<AttachmentPresignResponse>(
        'POST',
        `${attachmentsPath(ticket.ticket.id)}/presign`,
        sam,
        { kind: 'image', mime: 'image/png', size: bytes.byteLength, fileName: 'shot.png' },
      );

      const removed = await call(
        'DELETE',
        `${attachmentsPath(ticket.ticket.id)}/${presign.body.attachmentId}`,
        bo,
      );

      expect(removed.status).toBe(404);
    });
  });

  // ------------------------------------------------------- linking to a message

  describe('sending attachments with a message', () => {
    const reply = (ticketId: string, who: Person, attachmentIds: string[]) =>
      call<TicketMessage>(
        'POST',
        `/api/brands/${seeded.brandId}/tickets/${ticketId}/messages`,
        who,
        {
          kind: 'public',
          bodyHtml: '<p>Here you go.</p>',
          attachmentIds,
        },
      );

    it('links them and returns them on the message', async () => {
      const ticket = await createTicket(sam);
      const first = await upload(sam, ticket.ticket.id, { bytes: await png() });
      const second = await upload(sam, ticket.ticket.id, { bytes: await png(32) });

      const response = await reply(ticket.ticket.id, sam, [
        first.confirm?.body.id ?? '',
        second.confirm?.body.id ?? '',
      ]);

      expect(response.status).toBe(201);
      expect(response.body.attachments.map((row) => row.id).sort()).toEqual(
        [first.confirm?.body.id ?? '', second.confirm?.body.id ?? ''].sort(),
      );
    });

    it('shows them again on the next read of the thread', async () => {
      const ticket = await createTicket(sam);
      const uploaded = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await reply(ticket.ticket.id, sam, [uploaded.confirm?.body.id ?? '']);

      const detail = await call<TicketDetail>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${ticket.ticket.id}`,
        sam,
      );

      const withAttachment = detail.body.messages.messages.find(
        (message) => message.attachments.length > 0,
      );
      expect(withAttachment?.attachments[0]?.id).toBe(uploaded.confirm?.body.id);
    });

    it('refuses more than the brand allows, and sends nothing at all', async () => {
      const ticket = await createTicket(sam);
      const uploads = [];
      for (let index = 0; index < 6; index += 1) {
        uploads.push(await upload(sam, ticket.ticket.id, { bytes: await png(16 + index) }));
      }

      const before = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(attachments).where(eq(attachments.ticketId, ticket.ticket.id)),
      );

      const response = await reply(
        ticket.ticket.id,
        sam,
        uploads.map((one) => one.confirm?.body.id ?? ''),
      );

      expect(response.status).toBe(400);
      // Nothing was linked: the message and its links commit together.
      const after = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(attachments)
          .where(and(eq(attachments.ticketId, ticket.ticket.id), sql`message_id is not null`)),
      );
      expect(after).toHaveLength(0);
      expect(before).toHaveLength(6);
    });

    it('refuses an attachment somebody else uploaded', async () => {
      const ticket = await createTicket(ada, support);
      const uploaded = await upload(ada, ticket.ticket.id, { bytes: await png() });

      const response = await reply(ticket.ticket.id, sam, [uploaded.confirm?.body.id ?? '']);

      expect(response.status).toBe(400);
    });

    it('refuses an attachment uploaded against another ticket', async () => {
      const mine = await createTicket(sam);
      const other = await createTicket(sam);
      const uploaded = await upload(sam, other.ticket.id, { bytes: await png() });

      const response = await reply(mine.ticket.id, sam, [uploaded.confirm?.body.id ?? '']);

      expect(response.status).toBe(404);
    });

    it('refuses to send the same attachment twice', async () => {
      const ticket = await createTicket(sam);
      const uploaded = await upload(sam, ticket.ticket.id, { bytes: await png() });

      const first = await reply(ticket.ticket.id, sam, [uploaded.confirm?.body.id ?? '']);
      const second = await reply(ticket.ticket.id, sam, [uploaded.confirm?.body.id ?? '']);

      expect(first.status).toBe(201);
      expect(second.status).toBe(404);
    });
  });

  // --------------------------------------------------------- department moves

  describe('a ticket that moves department', () => {
    it('takes its attachments with it', async () => {
      const ticket = await createTicket(sam);
      const uploaded = await upload(sam, ticket.ticket.id, { bytes: await png() });
      await runProcessor(uploaded.confirm?.body.id ?? '');

      // The install admin's department scope is `all`, so they are the one who
      // can move a ticket between two departments neither agent shares.
      const moved = await app.inject({
        method: 'PATCH',
        url: `/api/brands/${seeded.brandId}/tickets/${ticket.ticket.id}`,
        headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ departmentId: billing }),
      });
      expect(moved.statusCode).toBe(200);

      // Without the trigger the attachment would stay readable by the
      // department the ticket has left and be invisible to the one it reached.
      const theirs = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${uploaded.confirm?.body.id}?variant=webp`,
        bo,
      );
      const ours = await call(
        'GET',
        `${attachmentsPath(ticket.ticket.id)}/${uploaded.confirm?.body.id}?variant=webp`,
        sam,
      );

      expect(theirs.status).toBe(200);
      expect(ours.status).toBe(404);
    });
  });
});
