import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FakeGraph,
  fixtureMid,
  GraphClient,
  instagramAttachment,
  instagramDeleted,
  instagramEcho,
  instagramReaction,
  instagramSeen,
  instagramStoryMention,
  instagramStoryReply,
  instagramText,
  instagramUnsupported,
  META_FIXTURE,
  type MetaWebhookBody,
  MetaWebhookDriver,
} from '@helpdock/channels';
import { createKeyring, type Env, encryptSecret } from '@helpdock/config';
import {
  attachments,
  blockedSenders,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  departments,
  type MetaAccount,
  metaAccounts,
  metaConversations,
  metaDeliveries,
  outbox,
  seedBrandStatuses,
  ticketMessages,
  ticketStatuses,
  tickets,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  createJobProcessor,
  type JobLogger,
  type MetaMediaFetchPayload,
  mediaProcessJob,
  metaProfileFetchJob,
  silentLogger,
} from '@helpdock/jobs';
import { contentPolicySchema } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, asc, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { createAttachmentUploadedHandler } from '../media/attachment-events.js';
import { createMediaTools } from '../media/ffmpeg.js';
import { createMediaProcessor } from '../media/process.job.js';
import { FakeStorage } from '../testing/media.js';
import { createMetaInboundService } from './factory.js';
import { MetaRepository } from './meta.repository.js';
import {
  createMetaMediaEventHandler,
  createMetaProfileEventHandler,
  META_EVENTS,
} from './meta-events.js';
import { createMetaProfileProcessor } from './meta-profile.job.js';

/**
 * M10-05 against real Postgres and Redis, with the stand-in for Graph and the
 * signed-webhook driver of M10-01: Instagram messages filed by the real
 * inbound service, behind the real webhook.
 *
 * 1. **A message**: text opens a ticket with the contact keyed on
 *    `<account>:<igsid>` and the `@username`; the next continues it; a
 *    redelivery files nothing; the closed-ticket policy; a blocked sender is
 *    dropped before anything is written.
 * 2. **Files, stories and shared posts**: an image is a `pending` attachment
 *    with a `meta.media` outbox row; a story reply and a story mention file the
 *    story's media and a line naming it, in the contact's language; a shared
 *    reel is a line with its URL.
 * 3. **The profile**: one read per conversation on the Instagram root with the
 *    account's token; a refusal costs the name, never the message.
 * 4. **Echoes, unsent messages, unsupported ones, receipts and reactions.**
 *
 * Media is fetched by M10-03's `meta.media_fetch` job and is not run here: this
 * suite proves the row and the outbox event the job starts from.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;

const APP_SECRET = 'integration-app-secret';
const INSTAGRAM_SECRET = 'integration-instagram-secret';

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const IG_A = '17841400000000000';
const IG_B = '17841400000000001';
const TOKEN_A = 'IGQWRPbGl0ZXRva2VuQWNtZVNob3AxMjM0NTY3ODkw';
const TOKEN_B = 'IGQWRPbGl0ZXRva2VuR2xvYmV4U2hvcDEyMzQ1Njc4';
const STORY_URL = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2&signature=y';

const JPEG = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 200 } },
})
  .jpeg()
  .toBuffer();

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M10-05 Instagram integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Seeded {
  readonly departmentId: string;
  readonly closedStatusId: string;
  readonly account: MetaAccount;
}

/** Seconds since the epoch, `seconds` ago: Meta's clock, never ahead of Helpdock's. */
const ago = (seconds: number): number => Math.floor(Date.now() / 1_000) - seconds;

describe.skipIf(!hasDocker)('Instagram (M10-05)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  const graph = new FakeGraph();
  const repository = new MetaRepository();
  const seeded = new Map<string, Seeded>();
  let driver: MetaWebhookDriver;
  let storage: FakeStorage;
  let counter = 0;

  /** A mid and an igsid no other test uses, so the cases cannot see each other's rows. */
  const next = (): number => {
    counter += 1;
    return counter;
  };
  const nextMid = (): string => fixtureMid(1_000 + next());
  const nextIgsid = (): string => `178414${String(next()).padStart(11, '0')}`;

  const envFor = (): Env =>
    ({
      APP_URL: 'https://support.example.com',
      APP_ROLE: 'api',
      APP_MASTER_KEY: MASTER_KEY,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: 0,
      TRUST_PROXY: false,
      DATABASE_URL: `postgres://helpdock_app:${APP_ROLE_PASSWORD}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`,
      DATABASE_MIGRATION_URL: postgres.getConnectionUri(),
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
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: ['127.0.0.0/8'],
      META_GRAPH_API_ROOT: graph.facebookRoot,
      META_INSTAGRAM_API_ROOT: graph.instagramRoot,
    }) as Env;

  const post = (body: MetaWebhookBody) => driver.post(body);

  const accountOf = (brandId: string): MetaAccount => {
    const found = seeded.get(brandId);
    if (found === undefined) {
      throw new Error('the brand was not seeded');
    }
    return found.account;
  };

  const conversationOf = async (accountId: string, customerId: string) => {
    const [row] = await owner.db
      .select()
      .from(metaConversations)
      .where(
        and(
          eq(metaConversations.accountId, accountId),
          eq(metaConversations.customerId, customerId),
        ),
      );
    return row;
  };

  const messagesOf = (ticketId: string) =>
    owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticketId))
      .orderBy(asc(ticketMessages.seq));

  const ticketOf = async (ticketId: string | null | undefined) => {
    const [row] = await owner.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId ?? ''));
    return row;
  };

  /** The conversation's ticket, which the suite expects to exist. */
  const ticketFor = async (account: MetaAccount, igsid: string) => {
    const conversation = await conversationOf(account.id, igsid);
    const ticket = await ticketOf(conversation?.ticketId);
    if (conversation === undefined || ticket === undefined) {
      throw new Error(`no conversation with a ticket for ${igsid}`);
    }
    return { conversation, ticket };
  };

  const systemLines = async (ticketId: string) =>
    (await messagesOf(ticketId)).filter((message) => message.kind === 'system');

  const profileCalls = (igsid: string) => graph.callsTo(`/${igsid}`, 'GET');

  /** The `meta.profile` events raised for one conversation, oldest first. */
  const profileEvents = async (conversationId: string) =>
    (
      await owner.db
        .select()
        .from(outbox)
        .where(eq(outbox.event, 'meta.profile'))
        .orderBy(asc(outbox.id))
    ).filter(
      (row) => (row.payload as { conversationId: string }).conversationId === conversationId,
    );

  const handledProfileEvents = new Set<string>();

  /**
   * The worker's half, played by hand as Telegram's suite plays it: every
   * `meta.profile` row nobody has handled is turned into its job by the event
   * handler and the job is run by the processor. Answers the errors the jobs
   * threw, which BullMQ would have retried.
   */
  const runProfileJobs = async (attemptsMade = 0, log: JobLogger = silentLogger) => {
    const process = createMetaProfileProcessor({
      db: runtime.db,
      log,
      repository,
      keyring: createKeyring(envFor()),
      graph: () =>
        new GraphClient({
          root: graph.facebookRoot,
          instagramRoot: graph.instagramRoot,
          allowCidrs: ['127.0.0.0/8'],
        }),
    });
    const rows = await owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.event, 'meta.profile'))
      .orderBy(asc(outbox.id));
    const thrown: unknown[] = [];
    for (const row of rows.filter((candidate) => !handledProfileEvents.has(candidate.id))) {
      handledProfileEvents.add(row.id);
      const added: { jobId: string; payload: unknown }[] = [];
      await withSystem(runtime.db, row.brandId, (tx) =>
        createMetaProfileEventHandler({ add: async (input) => void added.push(input) })({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        }),
      );
      for (const job of added) {
        await process({
          name: metaProfileFetchJob.name,
          id: job.jobId,
          data: job.payload,
          attemptsMade,
          opts: { attempts: 3 },
        } as unknown as Job).catch((error: unknown) => void thrown.push(error));
      }
    }
    return thrown;
  };

  const handledMedia = new Set<string>();

  /**
   * Every file of a ticket fetched by `meta.media_fetch` and processed by
   * `media.process`, as the worker does after the relay: the outbox rows ask for
   * the jobs, the jobs fetch through the stand-in, the pipeline makes the variants.
   * Answers what the fetches threw, which BullMQ would retry.
   */
  const mediaPipeline = async (ticketId: string): Promise<unknown[]> => {
    const ids = new Set(
      (await owner.db.select().from(attachments).where(eq(attachments.ticketId, ticketId))).map(
        (row) => row.id,
      ),
    );
    const { mediaFetch } = createMetaInboundService({
      db: runtime.db,
      storage,
      log: silentLogger,
      keyring: createKeyring(envFor()),
      graph: () =>
        new GraphClient({
          root: graph.facebookRoot,
          instagramRoot: graph.instagramRoot,
          allowCidrs: ['127.0.0.0/8'],
        }),
    });
    const errors: unknown[] = [];

    for (const row of await owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.event, META_EVENTS.media))) {
      if (handledMedia.has(row.id) || !ids.has(String(row.payload.attachmentId))) {
        continue;
      }
      handledMedia.add(row.id);
      const added: { jobId: string; payload: MetaMediaFetchPayload }[] = [];
      await withSystem(runtime.db, row.brandId, (tx) =>
        createMetaMediaEventHandler({ add: async (job) => void added.push(job) })({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        }),
      );
      for (const job of added) {
        await mediaFetch({
          name: 'meta.media_fetch',
          id: job.jobId,
          data: job.payload,
          attemptsMade: 0,
          opts: { attempts: 5 },
        } as unknown as Job).catch((error: unknown) => void errors.push(error));
      }
    }

    const process = createJobProcessor(
      mediaProcessJob,
      createMediaProcessor({
        storage,
        tools: createMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
        scanner: undefined,
      }),
      { db: runtime.db, log: silentLogger },
    );
    for (const row of await owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.event, 'attachment.uploaded'))) {
      if (handledMedia.has(row.id) || !ids.has(String(row.payload.attachmentId))) {
        continue;
      }
      handledMedia.add(row.id);
      const added: { jobId: string; payload: { brandId: string; attachmentId: string } }[] = [];
      await withSystem(runtime.db, row.brandId, (tx) =>
        createAttachmentUploadedHandler({ add: async (job) => void added.push(job) })({
          outboxId: row.id,
          brandId: row.brandId,
          event: row.event,
          payload: row.payload,
          tx,
          log: silentLogger,
        }),
      );
      for (const job of added) {
        await process({
          name: 'media.process',
          id: job.jobId,
          data: job.payload,
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as unknown as Job);
      }
    }

    return errors;
  };

  const contactNameOf = async (contactId: string) => {
    const [row] = await owner.db.select().from(contacts).where(eq(contacts.id, contactId));
    return row?.name;
  };

  const mediaEvents = () =>
    owner.db.select().from(outbox).where(eq(outbox.event, 'meta.media')).orderBy(asc(outbox.id));

  /** A reply of ours, delivered: the ticket message and the delivery that carries Meta's mid. */
  const seedReply = async (
    account: MetaAccount,
    igsid: string,
    options: { readonly mid: string; readonly text?: string },
  ) => {
    const { conversation, ticket } = await ticketFor(account, igsid);
    const [next] = await owner.db.execute<{ next: number }>(
      sql`select coalesce(max(seq), 0)::int + 1 as next from ticket_messages where ticket_id = ${ticket.id}`,
    );
    const text = options.text ?? 'We ship worldwide.';
    const [message] = await owner.db
      .insert(ticketMessages)
      .values({
        brandId: account.brandId,
        ticketId: ticket.id,
        departmentId: ticket.departmentId,
        seq: next?.next ?? 1,
        kind: 'public',
        authorType: 'staff',
        bodyHtml: `<p>${text}</p>`,
        bodyText: text,
        channel: 'instagram',
      })
      .returning();
    const [delivery] = await owner.db
      .insert(metaDeliveries)
      .values({
        brandId: account.brandId,
        departmentId: ticket.departmentId,
        ticketId: ticket.id,
        ticketMessageId: message?.id ?? '',
        accountId: account.id,
        conversationId: conversation.id,
        customerId: igsid,
        status: 'sent',
        partsSent: 1,
        platformMessageIds: [options.mid],
        sentAt: new Date(),
      })
      .returning();
    if (delivery === undefined) {
      throw new Error('the delivery was not written');
    }
    return { ticket, message, delivery };
  };

  const closeTicket = async (account: MetaAccount, ticketId: string, closedDaysAgo: number) => {
    const brand = seeded.get(account.brandId);
    await owner.db
      .update(tickets)
      .set({
        statusId: brand?.closedStatusId ?? '',
        closedAt: new Date(Date.now() - closedDaysAgo * 86_400_000),
      })
      .where(eq(tickets.id, ticketId));
  };

  const seedBrand = async (
    keyring: ReturnType<typeof createKeyring>,
    id: string,
    prefix: string,
    externalId: string,
    token: string,
  ): Promise<void> => {
    await runtime.db.insert(brands).values({ id, name: prefix, prefix });
    await withSystem(runtime.db, id, async (tx) => {
      await seedBrandStatuses(tx, id);
      const [department] = await tx
        .insert(departments)
        .values({ brandId: id, name: 'Support' })
        .returning({ id: departments.id });
      const [closed] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(and(eq(ticketStatuses.systemState, 'closed'), eq(ticketStatuses.isSpam, false)));
      const departmentId = department?.id ?? '';
      const [account] = await tx
        .insert(metaAccounts)
        .values({
          brandId: id,
          platform: 'instagram',
          departmentId,
          externalId,
          displayName: `${prefix} Instagram`,
          username: `${prefix.toLowerCase()}.shop`,
          accessToken: encryptSecret(token, keyring),
          tokenKind: 'instagram_user',
          tokenUpdatedAt: new Date(),
        })
        .returning();
      if (account === undefined) {
        throw new Error('the account was not written');
      }
      seeded.set(id, { departmentId, closedStatusId: closed?.id ?? '', account });
    });
    graph.connect({
      platform: 'instagram',
      id: externalId,
      name: `${prefix} Shop`,
      username: `${prefix.toLowerCase()}.shop`,
      token,
    });
  };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      graph.start(),
    ]);

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    // No inbound override: the webhook runs the real Instagram service.
    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-meta-instagram-')));
    app = await createApiApp({
      runtime,
      objectStorage: storage,
      meta: {
        graph: () =>
          new GraphClient({
            root: graph.facebookRoot,
            instagramRoot: graph.instagramRoot,
            allowCidrs: ['127.0.0.0/8'],
          }),
      },
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    // Instagram Login signs with the Instagram app secret.
    driver = new MetaWebhookDriver({ target: app, secret: INSTAGRAM_SECRET });

    const keyring = createKeyring(envFor());
    await seedBrand(keyring, BRAND_A, 'ACME', IG_A, TOKEN_A);
    await seedBrand(keyring, BRAND_B, 'GLOBEX', IG_B, TOKEN_B);
    await runtime.settings.set('meta.appSecret', APP_SECRET, { updatedBy: 'suite' });
    await runtime.settings.set('meta.instagramAppSecret', INSTAGRAM_SECRET, { updatedBy: 'suite' });
    await runtime.settings.set('meta.appId', META_FIXTURE.appId, { updatedBy: 'suite' });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    graph.reset();
    // A lookup an earlier test raised and left unrun is not this test's to run.
    const raised = await owner.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.event, 'meta.profile'));
    for (const row of raised) {
      handledProfileEvents.add(row.id);
    }
  });

  // --------------------------------------------------------------- messages

  describe('a message', () => {
    it('opens a ticket keyed on the account and the Instagram-scoped id, and calls Meta for nothing', async () => {
      const igsid = nextIgsid();
      const mid = nextMid();
      const sent = ago(30);

      const response = await post(
        instagramText({
          igAccountId: IG_A,
          igsid,
          mid,
          text: 'Do you ship to Dubai?',
          timestamp: sent,
        }),
      );

      expect(response).toEqual({ status: 200, body: '{"ok":true}' });
      const account = accountOf(BRAND_A);
      const { conversation, ticket } = await ticketFor(account, igsid);
      expect(ticket).toMatchObject({
        brandId: BRAND_A,
        departmentId: seeded.get(BRAND_A)?.departmentId,
        channel: 'instagram',
        subject: 'Do you ship to Dubai?',
        contactId: conversation.contactId,
      });
      expect(conversation).toMatchObject({
        brandId: BRAND_A,
        profileName: null,
        username: null,
        profileCheckedAt: null,
        lastInboundMessageId: mid,
      });
      // The reply window opens at Meta's time for the message.
      expect(conversation.lastInboundAt).toEqual(new Date(sent * 1_000));
      const [identity] = await owner.db
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.contactId, conversation.contactId));
      expect(identity).toMatchObject({
        kind: 'instagram',
        value: `${IG_A}:${igsid}`,
        verified: true,
        source: 'instagram.account',
      });
      // Meta's message carries no name; the contact waits for the profile job under its identity.
      expect(await contactNameOf(conversation.contactId)).toBe(`${IG_A}:${igsid}`);
      expect(await messagesOf(ticket.id)).toMatchObject([
        {
          kind: 'public',
          authorType: 'contact',
          channel: 'instagram',
          externalMessageId: mid,
          bodyText: 'Do you ship to Dubai?',
        },
      ]);
      // The webhook never calls Graph: it wrote one outbox row for the name instead.
      expect(graph.calls).toEqual([]);
      expect(await profileEvents(conversation.id)).toMatchObject([
        {
          brandId: BRAND_A,
          payload: {
            conversationId: conversation.id,
            accountId: account.id,
            platform: 'instagram',
          },
        },
      ]);
    });

    it('fills the name and the @username on the conversation and the contact once the job has run', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Omar Khalil', username: 'omar.k' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const account = accountOf(BRAND_A);
      const before = await conversationOf(account.id, igsid);

      const thrown = await runProfileJobs();

      expect(thrown).toEqual([]);
      const after = await conversationOf(account.id, igsid);
      expect(after).toMatchObject({ profileName: 'Omar Khalil', username: 'omar.k' });
      expect(after?.profileCheckedAt).not.toBeNull();
      expect(await contactNameOf(before?.contactId ?? '')).toBe('Omar Khalil');
      // One read, on the Instagram root, with the account's token and nothing else asked.
      const calls = profileCalls(igsid);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        root: 'instagram',
        token: TOKEN_A,
        query: { fields: 'name,username' },
      });
      expect(graph.calls).toHaveLength(1);
    });

    it('raises nothing for the next message once the customer is named', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Lina H', username: 'lina.h' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), timestamp: ago(60) }));
      await runProfileJobs();
      const conversation = await conversationOf(accountOf(BRAND_A).id, igsid);

      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), timestamp: ago(30) }));

      expect(await profileEvents(conversation?.id ?? '')).toHaveLength(1);
      expect(await runProfileJobs()).toEqual([]);
      expect(profileCalls(igsid)).toHaveLength(1);
    });

    it('reads once when a second message arrives before the first lookup has run', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Twice', username: 'twice' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), timestamp: ago(60) }));
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), timestamp: ago(30) }));
      const conversation = await conversationOf(accountOf(BRAND_A).id, igsid);
      // The conversation is still nameless when the second message is filed, so it asks too.
      expect(await profileEvents(conversation?.id ?? '')).toHaveLength(2);

      expect(await runProfileJobs()).toEqual([]);

      // The job is keyed by the conversation: the second finds the first's receipt.
      expect(profileCalls(igsid)).toHaveLength(1);
      expect(await conversationOf(accountOf(BRAND_A).id, igsid)).toMatchObject({
        profileName: 'Twice',
      });
    });

    it('leaves a contact an agent renamed alone, and still records the name on the conversation', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Real Name', username: 'real.name' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const account = accountOf(BRAND_A);
      const conversation = await conversationOf(account.id, igsid);
      await owner.db
        .update(contacts)
        .set({ name: 'Customer from the newsletter' })
        .where(eq(contacts.id, conversation?.contactId ?? ''));

      await runProfileJobs();

      expect(await contactNameOf(conversation?.contactId ?? '')).toBe(
        'Customer from the newsletter',
      );
      expect(await conversationOf(account.id, igsid)).toMatchObject({
        profileName: 'Real Name',
        username: 'real.name',
      });
    });

    it('continues the conversation’s ticket with the next message and moves the window forward', async () => {
      const igsid = nextIgsid();
      const first = nextMid();
      const second = nextMid();
      const secondAt = ago(20);
      graph.profiles.set(igsid, { name: 'Lina H', username: 'lina.h' });

      await post(
        instagramText({ igAccountId: IG_A, igsid, mid: first, text: 'First', timestamp: ago(120) }),
      );
      await post(
        instagramText({
          igAccountId: IG_A,
          igsid,
          mid: second,
          text: 'Second',
          timestamp: secondAt,
        }),
      );

      const { conversation, ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      expect(
        (await messagesOf(ticket.id)).map((message) => [message.seq, message.bodyText]),
      ).toEqual([
        [1, 'First'],
        [2, 'Second'],
      ]);
      expect(conversation.lastInboundMessageId).toBe(second);
      expect(conversation.lastInboundAt).toEqual(new Date(secondAt * 1_000));
    });

    it('files a redelivered message once', async () => {
      const igsid = nextIgsid();
      const mid = nextMid();
      const body = instagramText({ igAccountId: IG_A, igsid, mid, text: 'Once only' });

      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);

      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      expect((await messagesOf(ticket.id)).map((message) => message.bodyText)).toEqual([
        'Once only',
      ]);
      // The redelivery was dropped before it could raise a second lookup.
      const conversation = await conversationOf(accountOf(BRAND_A).id, igsid);
      expect(await profileEvents(conversation?.id ?? '')).toHaveLength(1);
    });

    it('records a refusal once, never stores it as a name, and raises nothing for the next message', async () => {
      const igsid = nextIgsid();
      graph.profileDenied.add(igsid);
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), text: 'Hello?' }));
      const account = accountOf(BRAND_A);

      const thrown = await runProfileJobs();

      // A 400 is an answer, not a failure to retry.
      expect(thrown).toEqual([]);
      const refused = await conversationOf(account.id, igsid);
      expect(refused).toMatchObject({ profileName: null, username: null });
      expect(refused?.profileCheckedAt).not.toBeNull();
      expect(await contactNameOf(refused?.contactId ?? '')).toBe(`${IG_A}:${igsid}`);
      expect(profileCalls(igsid)).toHaveLength(1);

      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), text: 'Still there?' }));

      expect(await profileEvents(refused?.id ?? '')).toHaveLength(1);
      expect(await runProfileJobs()).toEqual([]);
      expect(profileCalls(igsid)).toHaveLength(1);
    });

    it('leaves the customer unnamed when Meta fails, and the next message asks again', async () => {
      const igsid = nextIgsid();
      graph.failures.push({ status: 500, match: new RegExp(`GET /${igsid}`) });
      graph.profiles.set(igsid, { name: 'Noor', username: 'noor.a' });
      const response = await post(
        instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), text: 'Hi' }),
      );
      expect(response.status).toBe(200);
      const account = accountOf(BRAND_A);

      const thrown = await runProfileJobs();

      // BullMQ would retry; nothing is recorded, not even the receipt.
      expect(thrown).toHaveLength(1);
      const failed = await conversationOf(account.id, igsid);
      expect(failed).toMatchObject({ profileName: null, username: null, profileCheckedAt: null });

      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), text: 'Anyone?' }));

      expect(await profileEvents(failed?.id ?? '')).toHaveLength(2);
      expect(await runProfileJobs()).toEqual([]);
      expect(await conversationOf(account.id, igsid)).toMatchObject({
        profileName: 'Noor',
        username: 'noor.a',
      });
      const { ticket } = await ticketFor(account, igsid);
      expect(await messagesOf(ticket.id)).toHaveLength(2);
    });

    it('marks the account token_expired when Meta says the token is dead, and asks nothing more of it', async () => {
      const igsid = nextIgsid();
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const account = accountOf(BRAND_A);
      const waiting = await conversationOf(account.id, igsid);
      graph.expiredTokens.add(TOKEN_A);

      try {
        const thrown = await runProfileJobs();

        expect(thrown).toHaveLength(1);
        const [row] = await owner.db
          .select()
          .from(metaAccounts)
          .where(eq(metaAccounts.id, account.id));
        expect(row).toMatchObject({ status: 'token_expired' });
        expect(row?.lastError).not.toContain(TOKEN_A);
        expect(row?.lastErrorAt).not.toBeNull();
        // The row is left for the next attempt.
        expect(await conversationOf(account.id, igsid)).toMatchObject({ profileCheckedAt: null });

        await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));

        // An account that cannot answer is not asked to.
        expect(await profileEvents(waiting?.id ?? '')).toHaveLength(1);
      } finally {
        await owner.db
          .update(metaAccounts)
          .set({ status: 'connected', lastError: null, lastErrorAt: null })
          .where(eq(metaAccounts.id, account.id));
      }
    });

    it('reopens a ticket closed a day ago, and continues in a new one when it closed a month ago', async () => {
      const account = accountOf(BRAND_A);
      const recent = nextIgsid();
      graph.profiles.set(recent, { name: 'Recent', username: 'recent' });
      await post(instagramText({ igAccountId: IG_A, igsid: recent, mid: nextMid() }));
      const { ticket: recentTicket } = await ticketFor(account, recent);
      await closeTicket(account, recentTicket.id, 1);

      await post(instagramText({ igAccountId: IG_A, igsid: recent, mid: nextMid(), text: 'Back' }));

      const reopened = await ticketFor(account, recent);
      expect(reopened.ticket.id).toBe(recentTicket.id);
      expect(reopened.ticket.closedAt).toBeNull();

      const old = nextIgsid();
      graph.profiles.set(old, { name: 'Old', username: 'old' });
      await post(instagramText({ igAccountId: IG_A, igsid: old, mid: nextMid() }));
      const { ticket: oldTicket } = await ticketFor(account, old);
      await closeTicket(account, oldTicket.id, 30);

      await post(instagramText({ igAccountId: IG_A, igsid: old, mid: nextMid(), text: 'Again' }));

      const continued = await ticketFor(account, old);
      expect(continued.ticket.id).not.toBe(oldTicket.id);
      expect(continued.ticket.parentId).toBe(oldTicket.id);
    });

    it('drops a blocked sender before any contact exists and counts it', async () => {
      const igsid = nextIgsid();
      await owner.db
        .insert(blockedSenders)
        .values({ brandId: BRAND_A, kind: 'instagram', value: `${IG_A}:${igsid}` });

      const response = await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));

      expect(response.status).toBe(200);
      expect(await conversationOf(accountOf(BRAND_A).id, igsid)).toBeUndefined();
      expect(
        await owner.db
          .select({ id: contactIdentities.id })
          .from(contactIdentities)
          .where(eq(contactIdentities.value, `${IG_A}:${igsid}`)),
      ).toEqual([]);
      // Not even a lookup: nothing is asked of Meta about someone who is dropped.
      expect(graph.calls).toEqual([]);
      const raised = await owner.db.select().from(outbox).where(eq(outbox.event, 'meta.profile'));
      expect(raised.filter((row) => JSON.stringify(row.payload).includes(igsid))).toEqual([]);
      const [row] = await owner.db
        .select({ droppedCount: blockedSenders.droppedCount })
        .from(blockedSenders)
        .where(eq(blockedSenders.value, `${IG_A}:${igsid}`));
      expect(row?.droppedCount).toBe(1);
    });

    it('files two accounts of two brands in one batch as two tickets, each in its brand', async () => {
      const [igsidA, igsidB] = [nextIgsid(), nextIgsid()];
      graph.profiles.set(igsidA, { name: 'Ana', username: 'ana' });
      graph.profiles.set(igsidB, { name: 'Ben', username: 'ben' });

      const response = await driver.postBatch([
        instagramText({ igAccountId: IG_A, igsid: igsidA, mid: nextMid(), text: 'For Acme' }),
        instagramText({ igAccountId: IG_B, igsid: igsidB, mid: nextMid(), text: 'For Globex' }),
      ]);

      expect(response.status).toBe(200);
      const a = await ticketFor(accountOf(BRAND_A), igsidA);
      const b = await ticketFor(accountOf(BRAND_B), igsidB);
      expect(a.ticket.brandId).toBe(BRAND_A);
      expect(b.ticket.brandId).toBe(BRAND_B);
      expect(a.ticket.departmentId).toBe(seeded.get(BRAND_A)?.departmentId);
      expect(b.ticket.departmentId).toBe(seeded.get(BRAND_B)?.departmentId);
      // Each lookup is raised in its own brand and reads with its own account's token.
      expect(await profileEvents(a.conversation.id)).toMatchObject([{ brandId: BRAND_A }]);
      expect(await profileEvents(b.conversation.id)).toMatchObject([{ brandId: BRAND_B }]);
      expect(await runProfileJobs()).toEqual([]);
      expect(profileCalls(igsidA)[0]?.token).toBe(TOKEN_A);
      expect(profileCalls(igsidB)[0]?.token).toBe(TOKEN_B);
      expect(await contactNameOf(a.conversation.contactId)).toBe('Ana');
      expect(await contactNameOf(b.conversation.contactId)).toBe('Ben');
    });
  });

  describe('a customer id Helpdock cannot hold as an identifier', () => {
    it('is dropped, answered 200, and costs the rest of the batch nothing', async () => {
      const good = nextIgsid();

      const batch = await driver.postBatch([
        instagramText({ igAccountId: IG_A, igsid: 'not an id', mid: nextMid(), text: 'Odd one' }),
        instagramText({ igAccountId: IG_A, igsid: good, mid: nextMid(), text: 'Normal one' }),
      ]);

      expect(batch.status).toBe(200);
      const { ticket } = await ticketFor(accountOf(BRAND_A), good);
      expect(ticket).toBeDefined();
      expect(await conversationOf(accountOf(BRAND_A).id, 'not an id')).toBeUndefined();
    });
  });

  // ---------------------------------------------- files, stories, shared posts

  describe('what a customer attaches', () => {
    it('files an image as a pending attachment and asks for it through the outbox', async () => {
      const igsid = nextIgsid();
      const url = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=9&signature=a';
      graph.profiles.set(igsid, { name: 'Pic', username: 'pic' });

      await post(
        instagramAttachment({
          igAccountId: IG_A,
          igsid,
          mid: nextMid(),
          type: 'image',
          url,
          text: 'My order',
        }),
      );

      const account = accountOf(BRAND_A);
      const { ticket } = await ticketFor(account, igsid);
      const [message] = await messagesOf(ticket.id);
      const rows = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.ticketId, ticket.id));
      expect(rows).toMatchObject([
        { messageId: message?.id, kind: 'image', status: 'pending', uploaderType: 'contact' },
      ]);
      const events = (await mediaEvents()).filter(
        (row) => (row.payload as { attachmentId: string }).attachmentId === rows[0]?.id,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        brandId: BRAND_A,
        payload: {
          attachmentId: rows[0]?.id,
          accountId: account.id,
          ref: { kind: 'cdn_url', url, type: 'image' },
        },
      });
      // The request fetched nothing: the bytes are the job's.
      expect(graph.mediaRequests).toEqual([]);
    });

    it('rejects an image at once when the brand switched images off, and asks for nothing', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Off', username: 'off' });
      const policy = contentPolicySchema.parse({});
      await owner.db
        .update(brands)
        .set({
          settings: { contentPolicy: { ...policy, image: { ...policy.image, enabled: false } } },
        })
        .where(eq(brands.id, BRAND_A));

      try {
        await post(
          instagramAttachment({ igAccountId: IG_A, igsid, mid: nextMid(), type: 'image' }),
        );

        const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);
        const rows = await owner.db
          .select()
          .from(attachments)
          .where(eq(attachments.ticketId, ticket.id));
        expect(rows).toMatchObject([{ status: 'rejected', rejectReason: 'kind_disabled' }]);
        expect(
          (await mediaEvents()).filter(
            (row) => (row.payload as { attachmentId: string }).attachmentId === rows[0]?.id,
          ),
        ).toEqual([]);
      } finally {
        await owner.db.update(brands).set({ settings: {} }).where(eq(brands.id, BRAND_A));
      }
    });

    it('files a story reply with the story’s media and a line naming it, and the media reaches ready', async () => {
      const igsid = nextIgsid();
      const storyUrl = graph.serveCdn('story-reply.jpg', JPEG, 'image/jpeg');
      graph.profiles.set(igsid, { name: 'Story', username: 'story.fan' });

      await post(
        instagramStoryReply({
          igAccountId: IG_A,
          igsid,
          mid: nextMid(),
          text: 'Love this one!',
          url: storyUrl,
        }),
      );

      const account = accountOf(BRAND_A);
      const { ticket } = await ticketFor(account, igsid);
      const [message] = await messagesOf(ticket.id);
      expect(message?.bodyText).toBe(`Love this one!\nReplied to your story\n${storyUrl}`);
      const [pending] = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.ticketId, ticket.id));
      expect(pending).toMatchObject({ messageId: message?.id, status: 'pending', kind: 'image' });
      const events = (await mediaEvents()).filter(
        (row) => (row.payload as { attachmentId: string }).attachmentId === pending?.id,
      );
      expect(events).toMatchObject([
        {
          payload: {
            accountId: account.id,
            ref: { kind: 'cdn_url', url: storyUrl, type: 'story' },
          },
        },
      ]);
      // The webhook fetched nothing: the bytes are the job's.
      expect(graph.mediaRequests).toEqual([]);

      expect(await mediaPipeline(ticket.id)).toEqual([]);

      const [ready] = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.ticketId, ticket.id));
      expect(ready).toMatchObject({ status: 'ready', kind: 'image', size: JPEG.length });
      expect(Object.keys(ready?.variants ?? {})).toContain('webp');
      const webp = await storage.read(`brands/${BRAND_A}/tickets/${ticket.id}/${ready?.id}/webp`);
      expect((await sharp(webp).metadata()).format).toBe('webp');
      // A CDN link is fetched with no token: the story belongs to the customer's feed.
      expect(graph.mediaRequests).toEqual([
        { kind: 'cdn', name: 'story-reply.jpg', authorization: null },
      ]);
    });

    it('files a story mention in the contact’s language, in Arabic for an Arabic contact', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Salma', username: 'salma' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), text: 'مرحبا' }));
      const account = accountOf(BRAND_A);
      const { conversation, ticket } = await ticketFor(account, igsid);
      await owner.db
        .update(contacts)
        .set({ locale: 'ar' })
        .where(eq(contacts.id, conversation.contactId));

      await post(
        instagramStoryMention({ igAccountId: IG_A, igsid, mid: nextMid(), url: STORY_URL }),
      );

      const messages = await messagesOf(ticket.id);
      expect(messages[1]?.bodyText).toBe(`أشار إليك في قصته\n${STORY_URL}`);
      const rows = await owner.db
        .select()
        .from(attachments)
        .where(eq(attachments.messageId, messages[1]?.id ?? ''));
      expect(rows).toMatchObject([{ status: 'pending' }]);
    });

    it('files a shared reel as a line with its URL and no attachment', async () => {
      const igsid = nextIgsid();
      const url = 'https://www.instagram.com/reel/Cx1234/';
      graph.profiles.set(igsid, { name: 'Reel', username: 'reel.fan' });

      await post(
        instagramAttachment({ igAccountId: IG_A, igsid, mid: nextMid(), type: 'ig_reel', url }),
      );

      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      const [message] = await messagesOf(ticket.id);
      expect(message?.bodyText).toBe(url);
      expect(
        await owner.db.select().from(attachments).where(eq(attachments.ticketId, ticket.id)),
      ).toEqual([]);
    });

    it('leads a reply to an earlier message with that message’s text', async () => {
      const igsid = nextIgsid();
      const account = accountOf(BRAND_A);
      graph.profiles.set(igsid, { name: 'Quote', username: 'quote' });
      await post(
        instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), text: 'Do you ship to Dubai?' }),
      );
      const replyMid = nextMid();
      await seedReply(account, igsid, { mid: replyMid, text: 'Yes, in three days.' });

      await post(
        instagramText({
          igAccountId: IG_A,
          igsid,
          mid: nextMid(),
          text: 'Perfect, thanks',
          replyTo: replyMid,
        }),
      );

      const { ticket } = await ticketFor(account, igsid);
      const [reply] = (await messagesOf(ticket.id)).slice(-1);
      // The router quotes it, above the customer's own words (DOMAIN-RULES §4.8).
      expect(reply?.bodyHtml).toContain('<blockquote>');
      expect(reply?.bodyText).toContain('Yes, in three days.');
      expect(reply?.bodyText).toContain('Perfect, thanks');
      expect(reply?.bodyText.indexOf('Yes, in three days.')).toBeLessThan(
        reply?.bodyText.indexOf('Perfect, thanks') ?? 0,
      );
    });

    it('does not quote a message that is on another conversation’s ticket', async () => {
      const [mine, theirs] = [nextIgsid(), nextIgsid()];
      const account = accountOf(BRAND_A);
      graph.profiles.set(mine, { name: 'Mine', username: 'mine' });
      graph.profiles.set(theirs, { name: 'Theirs', username: 'theirs' });
      const secretMid = nextMid();
      await post(
        instagramText({ igAccountId: IG_A, igsid: theirs, mid: secretMid, text: 'Private words' }),
      );
      await post(instagramText({ igAccountId: IG_A, igsid: mine, mid: nextMid() }));

      await post(
        instagramText({
          igAccountId: IG_A,
          igsid: mine,
          mid: nextMid(),
          text: 'Replying',
          replyTo: secretMid,
        }),
      );

      const { ticket } = await ticketFor(account, mine);
      const [reply] = (await messagesOf(ticket.id)).slice(-1);
      expect(reply?.bodyText).toBe('Replying');
      expect(reply?.bodyHtml).not.toContain('blockquote');
    });
  });

  // ------------------------------------------------------------------ echoes

  describe('an echo', () => {
    const echoWith = (
      igsid: string,
      mid: string,
      extra: Record<string, unknown>,
    ): MetaWebhookBody => {
      const body = structuredClone(instagramEcho({ igAccountId: IG_A, igsid, mid, text: 'Echo' }));
      const entry = (body.entry as { messaging: { message: Record<string, unknown> }[] }[])[0];
      Object.assign(entry?.messaging[0]?.message ?? {}, extra);
      return body;
    };

    const messageCount = async (ticketId: string): Promise<number> =>
      (await messagesOf(ticketId)).length;

    it('of a Helpdock send, by app id, files nothing', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Echo', username: 'echo' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      const before = await messageCount(ticket.id);

      const response = await post(echoWith(igsid, nextMid(), { app_id: META_FIXTURE.appId }));

      expect(response.status).toBe(200);
      expect(await messageCount(ticket.id)).toBe(before);
    });

    it('of a Helpdock send, by the delivery id in metadata, files nothing', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Echo2', username: 'echo2' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const account = accountOf(BRAND_A);
      const replyMid = nextMid();
      const { ticket, delivery } = await seedReply(account, igsid, { mid: replyMid });
      const before = await messageCount(ticket.id);

      await post(echoWith(igsid, replyMid, { metadata: delivery.id }));

      expect(await messageCount(ticket.id)).toBe(before);
    });

    it('typed outside Helpdock is dropped too, not filed as the customer’s', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Echo3', username: 'echo3' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      const before = await messageCount(ticket.id);

      const response = await post(echoWith(igsid, nextMid(), { app_id: '999' }));

      expect(response.status).toBe(200);
      expect(await messageCount(ticket.id)).toBe(before);
    });
  });

  // ------------------------------------------------------------------ unsent

  describe('an unsent message', () => {
    it('keeps its row and its body and gains a system line, once', async () => {
      const igsid = nextIgsid();
      const mid = nextMid();
      graph.profiles.set(igsid, { name: 'Unsender', username: 'unsender' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid, text: 'Wrong thread, sorry' }));
      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      const [original] = await messagesOf(ticket.id);
      const body = instagramDeleted({ igAccountId: IG_A, igsid, mid });

      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);

      const messages = await messagesOf(ticket.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        id: original?.id,
        kind: 'public',
        bodyText: 'Wrong thread, sorry',
        externalMessageId: mid,
      });
      expect(messages[1]).toMatchObject({
        kind: 'system',
        authorType: 'system',
        bodyText: 'The customer unsent this message.',
        bodyHtml: '<p>The customer unsent this message.</p>',
        externalMessageId: `unsent:${mid}`,
        channel: 'instagram',
      });
    });

    it('writes the line in the contact’s language', async () => {
      const igsid = nextIgsid();
      const mid = nextMid();
      graph.profiles.set(igsid, { name: 'Ar', username: 'ar.user' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid }));
      const { conversation, ticket } = await ticketFor(accountOf(BRAND_A), igsid);
      await owner.db
        .update(contacts)
        .set({ locale: 'ar' })
        .where(eq(contacts.id, conversation.contactId));

      await post(instagramDeleted({ igAccountId: IG_A, igsid, mid }));

      expect((await systemLines(ticket.id)).map((line) => line.bodyText)).toEqual([
        'ألغى العميل إرسال هذه الرسالة.',
      ]);
    });

    it('files nothing for a message Helpdock never filed', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Ghost', username: 'ghost' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);

      const response = await post(instagramDeleted({ igAccountId: IG_A, igsid, mid: nextMid() }));

      expect(response.status).toBe(200);
      expect(await systemLines(ticket.id)).toEqual([]);
    });

    it('puts the line on the primary when the message’s ticket was merged', async () => {
      const account = accountOf(BRAND_A);
      const [secondary, primary] = [nextIgsid(), nextIgsid()];
      const mid = nextMid();
      graph.profiles.set(secondary, { name: 'Sec', username: 'sec' });
      graph.profiles.set(primary, { name: 'Pri', username: 'pri' });
      await post(instagramText({ igAccountId: IG_A, igsid: secondary, mid }));
      await post(instagramText({ igAccountId: IG_A, igsid: primary, mid: nextMid() }));
      const from = await ticketFor(account, secondary);
      const into = await ticketFor(account, primary);
      await owner.db
        .update(tickets)
        .set({ mergedIntoId: into.ticket.id })
        .where(eq(tickets.id, from.ticket.id));

      await post(instagramDeleted({ igAccountId: IG_A, igsid: secondary, mid }));

      expect(await systemLines(from.ticket.id)).toEqual([]);
      expect((await systemLines(into.ticket.id)).map((line) => line.externalMessageId)).toEqual([
        `unsent:${mid}`,
      ]);
    });
  });

  // ------------------------------------------------------------- unsupported

  describe('something Instagram cannot show', () => {
    it('is a system line on the ticket, counted once, and the customer’s window moves', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Poll', username: 'poll.fan' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid(), timestamp: ago(600) }));
      const account = accountOf(BRAND_A);
      const mid = nextMid();
      const at = ago(10);
      const body = instagramUnsupported({ igAccountId: IG_A, igsid, mid, timestamp: at });

      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);

      const { conversation, ticket } = await ticketFor(account, igsid);
      expect((await systemLines(ticket.id)).map((line) => line.bodyText)).toEqual([
        'The customer sent something that cannot be shown here.',
      ]);
      expect(conversation.lastInboundMessageId).toBe(mid);
      expect(conversation.lastInboundAt).toEqual(new Date(at * 1_000));
    });

    it('opens no ticket when it is the customer’s first message', async () => {
      const igsid = nextIgsid();

      const response = await post(
        instagramUnsupported({ igAccountId: IG_A, igsid, mid: nextMid() }),
      );

      expect(response.status).toBe(200);
      expect(await conversationOf(accountOf(BRAND_A).id, igsid)).toBeUndefined();
      expect(profileCalls(igsid)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- receipts

  describe('messaging_seen', () => {
    it('marks the reply it names read, and delivered with it, at Meta’s time', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Reader', username: 'reader' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const account = accountOf(BRAND_A);
      const replyMid = nextMid();
      const { delivery } = await seedReply(account, igsid, { mid: replyMid });
      const seen = ago(5);

      const response = await post(
        instagramSeen({ igAccountId: IG_A, igsid, mid: replyMid, timestamp: seen }),
      );

      expect(response.status).toBe(200);
      const after = await withSystem(runtime.db, BRAND_A, (tx) =>
        repository.delivery(tx, delivery.id),
      );
      expect(after).toMatchObject({ status: 'read' });
      expect(after?.readAt).toEqual(new Date(seen * 1_000));
      expect(after?.deliveredAt).toEqual(new Date(seen * 1_000));
    });

    it('leaves a delivery that is already read alone, and answers 200 for a mid that is not ours', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Twice', username: 'twice' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const replyMid = nextMid();
      const { delivery } = await seedReply(accountOf(BRAND_A), igsid, { mid: replyMid });
      const firstSeen = ago(30);
      await post(instagramSeen({ igAccountId: IG_A, igsid, mid: replyMid, timestamp: firstSeen }));

      await post(instagramSeen({ igAccountId: IG_A, igsid, mid: replyMid, timestamp: ago(5) }));
      const unknown = await post(
        instagramSeen({ igAccountId: IG_A, igsid, mid: nextMid(), timestamp: ago(5) }),
      );

      expect(unknown.status).toBe(200);
      const after = await withSystem(runtime.db, BRAND_A, (tx) =>
        repository.delivery(tx, delivery.id),
      );
      expect(after?.readAt).toEqual(new Date(firstSeen * 1_000));
    });
  });

  // --------------------------------------------------------------- reactions

  describe('a reaction', () => {
    it('is a system line on the message’s ticket, never a message, and a reaction taken back is another line', async () => {
      const igsid = nextIgsid();
      const mid = nextMid();
      graph.profiles.set(igsid, { name: 'Fan', username: 'fan' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid, timestamp: ago(90) }));
      const { conversation, ticket } = await ticketFor(accountOf(BRAND_A), igsid);

      await post(instagramReaction({ igAccountId: IG_A, igsid, mid, emoji: '❤️' }));
      await post(instagramReaction({ igAccountId: IG_A, igsid, mid, action: 'unreact' }));

      const messages = await messagesOf(ticket.id);
      expect(messages).toHaveLength(3);
      expect(messages[1]).toMatchObject({
        kind: 'system',
        bodyText: 'The customer reacted ❤️ to a message.',
      });
      expect(messages[2]).toMatchObject({
        kind: 'system',
        bodyText: 'The customer removed their reaction to a message.',
      });
      // Not an anchor: the window still opens at the message.
      const after = await conversationOf(accountOf(BRAND_A).id, igsid);
      expect(after?.lastInboundAt).toEqual(conversation.lastInboundAt);
    });

    it('lands on the ticket of the reply it reacts to', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Fan2', username: 'fan2' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const replyMid = nextMid();
      const { ticket } = await seedReply(accountOf(BRAND_A), igsid, { mid: replyMid });

      await post(instagramReaction({ igAccountId: IG_A, igsid, mid: replyMid }));

      expect((await systemLines(ticket.id)).map((line) => line.bodyText)).toHaveLength(1);
    });

    it('files nothing for a message it does not know', async () => {
      const igsid = nextIgsid();
      graph.profiles.set(igsid, { name: 'Fan3', username: 'fan3' });
      await post(instagramText({ igAccountId: IG_A, igsid, mid: nextMid() }));
      const { ticket } = await ticketFor(accountOf(BRAND_A), igsid);

      await post(instagramReaction({ igAccountId: IG_A, igsid, mid: nextMid() }));

      expect(await systemLines(ticket.id)).toEqual([]);
    });
  });
});
