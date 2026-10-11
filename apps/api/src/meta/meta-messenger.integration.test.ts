import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  FakeGraph,
  fixtureMid,
  GraphClient,
  META_FIXTURE,
  type MetaWebhookBody,
  MetaWebhookDriver,
  pageAttachment,
  pageDelivery,
  pageEcho,
  pageEdit,
  pageFallback,
  pagePostback,
  pageReaction,
  pageRead,
  pageSticker,
  pageText,
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
  type DbTransaction,
  departments,
  type MetaAccount,
  type MetaConversation,
  type MetaDelivery,
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
  type MetaMediaFetchPayload,
  mediaProcessJob,
  silentLogger,
} from '@helpdock/jobs';
import { metaAccountHealth } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
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
import { createMetaMediaEventHandler, META_EVENTS } from './meta-events.js';

/**
 * M10-04, Messenger inbound, against real Postgres and Redis through the
 * signed-webhook driver and the stand-in for Graph (`FakeGraph`), with no
 * double in the way: the webhook, the seam, the Messenger service, the router
 * and the sink are the real ones.
 *
 * 1. **Messages**: a message opens a ticket under `<page id>:<psid>` and asks
 *    for the customer's name with a `meta.profile` outbox row, the webhook
 *    calling nothing; a second continues it; a redelivery files nothing; a
 *    blocked sender is dropped before a contact exists; the reopen policy
 *    applies; files become `pending` attachments and `meta.media` outbox rows
 *    (nothing is fetched in the request); two Pages of two brands in one batch
 *    file into their brands.
 * 2. **Echoes**: the echo of a Helpdock send files nothing, and nor does any
 *    other.
 * 3. **Receipts**: a watermark marks the earlier deliveries of the
 *    conversation and not the later one, and never moves one backwards.
 * 4. **Lines in the thread**: a reaction on a reply, an edit, content
 *    Helpdock cannot show.
 * 5. **Counted and dropped**: postbacks, referrals, standby, and policy
 *    enforcement, which also goes on the account.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;

const APP_SECRET = 'messenger-app-secret';
const PAGE_TOKEN = 'EAAGmessengerpagetoken';
const OTHER_APPS_ID = '263902037430900';

const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const PAGE_A = META_FIXTURE.pageId;
const PAGE_B = '998877665544332';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M10-04 Messenger integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const JPEG = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 200 } },
})
  .jpeg()
  .toBuffer();

interface Seeded {
  readonly departmentId: string;
  readonly account: MetaAccount;
}

/** Seconds since the epoch as a `Date`. */
const at = (seconds: number): Date => new Date(seconds * 1_000);

describe.skipIf(!hasDocker)('Messenger (M10-04)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let driver: MetaWebhookDriver;
  let storage: FakeStorage;
  const graph = new FakeGraph();
  const repository = new MetaRepository();
  const handledOutbox = new Set<string>();
  const seeded = new Map<string, Seeded>();

  /** A customer of its own for every test, so conversations never meet. */
  let customers = 0;
  const newPsid = (): string => {
    customers += 1;
    return `76543210987${String(customers).padStart(5, '0')}`;
  };
  let mids = 100;
  const newMid = (): string => {
    mids += 1;
    return fixtureMid(mids);
  };

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

  const accountA = (): MetaAccount => {
    const found = seeded.get(BRAND_A);
    if (found === undefined) {
      throw new Error('brand A is not seeded');
    }
    return found.account;
  };

  const seedBrand = async (
    keyring: ReturnType<typeof createKeyring>,
    id: string,
    prefix: string,
    pageId: string,
  ): Promise<void> => {
    await runtime.db.insert(brands).values({ id, name: prefix, prefix });
    await withSystem(runtime.db, id, async (tx) => {
      await seedBrandStatuses(tx, id);
      const [department] = await tx
        .insert(departments)
        .values({ brandId: id, name: 'Support' })
        .returning({ id: departments.id });
      const [account] = await tx
        .insert(metaAccounts)
        .values({
          brandId: id,
          platform: 'messenger',
          departmentId: department?.id ?? '',
          externalId: pageId,
          displayName: `${prefix} Page`,
          accessToken: encryptSecret(PAGE_TOKEN, keyring),
          tokenKind: 'page',
          tokenUpdatedAt: new Date(),
        })
        .returning();
      if (account === undefined || department === undefined) {
        throw new Error('the seed wrote nothing');
      }
      seeded.set(id, { departmentId: department.id, account });
    });
  };

  const graphClient = () =>
    new GraphClient({
      root: graph.facebookRoot,
      instagramRoot: graph.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
    });

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
    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-messenger-')));
    app = await createApiApp({ runtime, objectStorage: storage, meta: { graph: graphClient } });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    driver = new MetaWebhookDriver({ target: app, secret: APP_SECRET });

    const keyring = createKeyring(envFor());
    await seedBrand(keyring, BRAND_A, 'ACME', PAGE_A);
    await seedBrand(keyring, BRAND_B, 'GLOBEX', PAGE_B);
    graph.connect({ platform: 'messenger', id: PAGE_A, name: 'Acme Page', token: PAGE_TOKEN });

    await runtime.settings.set('meta.appSecret', APP_SECRET, { updatedBy: 'suite' });
    await runtime.settings.set('meta.appId', META_FIXTURE.appId, { updatedBy: 'suite' });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(() => {
    graph.reset();
  });

  // --------------------------------------------------------------- helpers

  const post = async (body: MetaWebhookBody): Promise<void> => {
    expect(await driver.post(body)).toEqual({ status: 200, body: '{"ok":true}' });
  };

  const identityOf = (psid: string, pageId: string = PAGE_A): string => `${pageId}:${psid}`;

  const ticketsOf = async (psid: string, pageId: string = PAGE_A) =>
    (
      await owner.db
        .select({ ticket: tickets })
        .from(tickets)
        .innerJoin(contactIdentities, eq(contactIdentities.contactId, tickets.contactId))
        .where(
          and(
            eq(contactIdentities.kind, 'messenger'),
            eq(contactIdentities.value, identityOf(psid, pageId)),
          ),
        )
        .orderBy(tickets.createdAt)
    ).map((row) => row.ticket);

  const contactsOf = (psid: string, pageId: string = PAGE_A) =>
    owner.db
      .select({ contact: contacts, identity: contactIdentities })
      .from(contactIdentities)
      .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
      .where(
        and(
          eq(contactIdentities.kind, 'messenger'),
          eq(contactIdentities.value, identityOf(psid, pageId)),
        ),
      );

  const messagesOf = (ticketId: string) =>
    owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticketId))
      .orderBy(ticketMessages.seq);

  const conversationOf = async (psid: string, account = accountA()): Promise<MetaConversation> => {
    const [row] = await owner.db
      .select()
      .from(metaConversations)
      .where(
        and(eq(metaConversations.accountId, account.id), eq(metaConversations.customerId, psid)),
      );
    if (row === undefined) {
      throw new Error(`no conversation with ${psid}`);
    }
    return row;
  };

  /** The `meta.profile` rows asked for a conversation: the profile job's work, not run here. */
  const profileRequests = async (conversationId: string) =>
    (
      await owner.db
        .select({ payload: outbox.payload })
        .from(outbox)
        .where(eq(outbox.event, 'meta.profile'))
    )
      .map((row) => row.payload as { conversationId: string })
      .filter((payload) => payload.conversationId === conversationId);

  const accountRow = async (account = accountA()): Promise<MetaAccount> => {
    const [row] = await owner.db.select().from(metaAccounts).where(eq(metaAccounts.id, account.id));
    if (row === undefined) {
      throw new Error('the account is gone');
    }
    return row;
  };

  const systemLines = async (ticketId: string): Promise<string[]> =>
    (await messagesOf(ticketId)).filter((row) => row.kind === 'system').map((row) => row.bodyText);

  /** A customer who has written once: their ticket and conversation. */
  const customerWhoWrote = async (text = 'Hello, is anyone there?') => {
    const psid = newPsid();
    const mid = newMid();
    await post(pageText({ psid, mid, text }));
    const [ticket] = await ticketsOf(psid);
    if (ticket === undefined) {
      throw new Error('the message opened no ticket');
    }
    return { psid, mid, ticket, conversation: await conversationOf(psid) };
  };

  /**
   * One agent reply to the conversation, delivered to Meta at `sentAt` seconds
   * and known to Meta as `platformMessageId`: what the send job leaves behind.
   */
  const agentReply = (
    conversation: MetaConversation,
    ticketId: string,
    sentAt: number,
    platformMessageId: string,
    over: { readonly text?: string } = {},
  ): Promise<MetaDelivery> =>
    withSystem(runtime.db, BRAND_A, async (tx: DbTransaction) => {
      const [next] = await tx.execute<{ next: number }>(
        sql`select coalesce(max(seq), 0)::int + 1 as next from ticket_messages where ticket_id = ${ticketId}`,
      );
      const [message] = await tx
        .insert(ticketMessages)
        .values({
          brandId: BRAND_A,
          ticketId,
          departmentId: seeded.get(BRAND_A)?.departmentId ?? '',
          seq: next?.next ?? 1,
          kind: 'public',
          authorType: 'staff',
          authorId: uuidv7(),
          bodyHtml: `<p>${over.text ?? 'We are on it.'}</p>`,
          bodyText: over.text ?? 'We are on it.',
          channel: 'messenger',
        })
        .returning();
      const delivery = await repository.insertDelivery(tx, {
        brandId: BRAND_A,
        departmentId: seeded.get(BRAND_A)?.departmentId ?? '',
        ticketId,
        ticketMessageId: message?.id ?? '',
        accountId: accountA().id,
        conversationId: conversation.id,
        customerId: conversation.customerId,
      });
      if (delivery === undefined) {
        throw new Error('the delivery was not written');
      }
      await repository.recordPart(tx, delivery.id, platformMessageId);
      await repository.markSent(tx, delivery.id, at(sentAt));
      return delivery;
    });

  const deliveryRow = async (id: string): Promise<MetaDelivery> => {
    const [row] = await owner.db.select().from(metaDeliveries).where(eq(metaDeliveries.id, id));
    if (row === undefined) {
      throw new Error('the delivery is gone');
    }
    return row;
  };

  const closeTicket = async (ticketId: string, closedAt: Date): Promise<void> => {
    const [closed] = await owner.db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(
        and(
          eq(ticketStatuses.brandId, BRAND_A),
          eq(ticketStatuses.systemState, 'closed'),
          eq(ticketStatuses.isSpam, false),
        ),
      );
    await owner.db
      .update(tickets)
      .set({ statusId: closed?.id ?? '', closedAt })
      .where(eq(tickets.id, ticketId));
  };

  // --------------------------------------------------------------- messages

  describe('a message', () => {
    it('opens a ticket under the Page-scoped contact and asks for the customer’s name, without asking Meta', async () => {
      const psid = newPsid();
      const mid = newMid();

      await post(pageText({ psid, mid, text: 'My order #77 has not arrived' }));

      const [ticket] = await ticketsOf(psid);
      expect(ticket).toMatchObject({
        brandId: BRAND_A,
        channel: 'messenger',
        departmentId: seeded.get(BRAND_A)?.departmentId,
        subject: 'My order #77 has not arrived',
      });
      const [found] = await contactsOf(psid);
      // Named by its id until the profile job has the name; the thread says "Messenger user".
      expect(found?.contact.name).toBe(identityOf(psid));
      expect(found?.identity).toMatchObject({
        kind: 'messenger',
        value: identityOf(psid),
        verified: true,
        source: 'messenger.page',
      });
      expect(await messagesOf(ticket?.id ?? '')).toMatchObject([
        {
          kind: 'public',
          authorType: 'contact',
          authorId: found?.contact.id,
          channel: 'messenger',
          externalMessageId: mid,
          bodyText: 'My order #77 has not arrived',
        },
      ]);
      expect(await conversationOf(psid)).toMatchObject({
        contactId: found?.contact.id,
        ticketId: ticket?.id,
        profileName: null,
        lastInboundMessageId: mid,
        lastInboundAt: at(META_FIXTURE.time),
      });

      // The webhook never calls Graph (ADR 0025): the name is an outbox row for a job.
      expect(graph.calls).toEqual([]);
      expect(await profileRequests((await conversationOf(psid)).id)).toEqual([
        {
          conversationId: (await conversationOf(psid)).id,
          accountId: accountA().id,
          platform: 'messenger',
        },
      ]);
      expect((await accountRow()).lastEventAt).not.toBeNull();
    });

    it('continues the conversation’s ticket with the next message', async () => {
      const first = await customerWhoWrote('First message');
      const mid = newMid();

      await post(
        pageText({
          psid: first.psid,
          mid,
          text: 'A second one',
          timestamp: META_FIXTURE.time + 60,
        }),
      );

      expect(await ticketsOf(first.psid)).toHaveLength(1);
      expect((await messagesOf(first.ticket.id)).map((row) => [row.kind, row.bodyText])).toEqual([
        ['public', 'First message'],
        ['public', 'A second one'],
      ]);
      expect(graph.calls).toEqual([]);
      expect(await conversationOf(first.psid)).toMatchObject({
        lastInboundMessageId: mid,
        lastInboundAt: at(META_FIXTURE.time + 60),
      });
    });

    it('files a message delivered twice once', async () => {
      const psid = newPsid();
      const mid = newMid();
      const body = pageText({ psid, mid, text: 'Any news?' });

      await post(body);
      await post(body);

      const [ticket] = await ticketsOf(psid);
      expect(await ticketsOf(psid)).toHaveLength(1);
      expect(
        (await messagesOf(ticket?.id ?? '')).filter((row) => row.externalMessageId === mid),
      ).toHaveLength(1);
    });

    it('does not ask for the name of a conversation that has one', async () => {
      const { psid, conversation } = await customerWhoWrote();
      await owner.db
        .update(metaConversations)
        .set({ profileName: 'Mona Khalil' })
        .where(eq(metaConversations.id, conversation.id));
      const before = (await profileRequests(conversation.id)).length;

      await post(pageText({ psid, mid: newMid(), text: 'Hello again' }));

      expect(before).toBe(1);
      expect(await profileRequests(conversation.id)).toHaveLength(before);
    });

    it('drops a blocked sender before a contact exists, and counts it', async () => {
      const psid = newPsid();
      await owner.db
        .insert(blockedSenders)
        .values({ brandId: BRAND_A, kind: 'messenger', value: identityOf(psid) });

      await post(pageText({ psid, mid: newMid(), text: 'Buy now' }));

      expect(await contactsOf(psid)).toEqual([]);
      expect(await ticketsOf(psid)).toEqual([]);
      expect(graph.calls).toEqual([]);
      const [row] = await owner.db
        .select({ droppedCount: blockedSenders.droppedCount })
        .from(blockedSenders)
        .where(eq(blockedSenders.value, identityOf(psid)));
      expect(row?.droppedCount).toBe(1);
    });

    it('reopens a ticket closed inside the reopen window, and continues one closed past it in a new ticket', async () => {
      const { psid, ticket } = await customerWhoWrote('Is it fixed?');

      await closeTicket(ticket.id, new Date());
      await post(pageText({ psid, mid: newMid(), text: 'Still broken' }));
      const [reopened] = await ticketsOf(psid);
      expect(await ticketsOf(psid)).toHaveLength(1);
      expect(reopened?.closedAt).toBeNull();

      await closeTicket(ticket.id, new Date(Date.now() - 30 * 24 * 3_600_000));
      await post(pageText({ psid, mid: newMid(), text: 'Broken again' }));

      const after = await ticketsOf(psid);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ parentId: ticket.id, channel: 'messenger' });
      expect((await conversationOf(psid)).ticketId).toBe(after[1]?.id);
      expect((await messagesOf(after[1]?.id ?? '')).map((row) => row.bodyText)).toContain(
        'Broken again',
      );
    });

    it('files each of two Pages’ messages in the brand whose Page it came to, from one batch', async () => {
      const psid = newPsid();
      const batch = await driver.postBatch([
        pageText({ pageId: PAGE_A, psid, mid: newMid(), text: 'For Acme' }),
        pageText({ pageId: PAGE_B, psid, mid: newMid(), text: 'For Globex' }),
      ]);

      expect(batch.status).toBe(200);
      const [acme] = await ticketsOf(psid, PAGE_A);
      const [globex] = await ticketsOf(psid, PAGE_B);
      expect(acme).toMatchObject({ brandId: BRAND_A, subject: 'For Acme' });
      expect(globex).toMatchObject({ brandId: BRAND_B, subject: 'For Globex' });
      expect((await contactsOf(psid, PAGE_A))[0]?.contact.brandId).toBe(BRAND_A);
      expect((await contactsOf(psid, PAGE_B))[0]?.contact.brandId).toBe(BRAND_B);
    });
  });

  describe('a customer id Helpdock cannot hold as an identifier', () => {
    it('is dropped, answered 200, and costs the rest of the batch nothing', async () => {
      const good = newPsid();

      const batch = await driver.postBatch([
        pageText({ psid: 'not an id', mid: newMid(), text: 'Odd one' }),
        pageText({ psid: good, mid: newMid(), text: 'Normal one' }),
      ]);

      expect(batch.status).toBe(200);
      expect(await contactsOf('not an id')).toEqual([]);
      expect(await ticketsOf(good)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ files

  describe('a file', () => {
    const urlOf = (name: string): string =>
      `https://scontent.xx.fbcdn.net/v/t1.15752-9/${name}?oh=00&oe=00`;

    const attachmentsOf = (ticketId: string) =>
      owner.db.select().from(attachments).where(eq(attachments.ticketId, ticketId));

    const mediaEvents = async (attachmentId: string) =>
      (
        await owner.db
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(eq(outbox.event, 'meta.media'))
      )
        .map((row) => row.payload as { attachmentId: string })
        .filter((payload) => payload.attachmentId === attachmentId);

    /** The worker's half, played by hand as the WhatsApp suite plays it: the relay and BullMQ are covered elsewhere. */
    interface FetchJob {
      readonly jobId: string;
      readonly payload: MetaMediaFetchPayload;
    }

    const fetchJobsFor = async (ids: ReadonlySet<string>): Promise<FetchJob[]> => {
      const rows = await owner.db.select().from(outbox).where(eq(outbox.event, META_EVENTS.media));
      const jobs: FetchJob[] = [];
      for (const row of rows) {
        if (handledOutbox.has(row.id) || !ids.has(String(row.payload.attachmentId))) {
          continue;
        }
        handledOutbox.add(row.id);
        await withSystem(runtime.db, row.brandId, (tx) =>
          createMetaMediaEventHandler({
            add: async (job) => void jobs.push({ jobId: job.jobId, payload: job.payload }),
          })({
            outboxId: row.id,
            brandId: row.brandId,
            event: row.event,
            payload: row.payload,
            tx,
            log: silentLogger,
          }),
        );
      }
      return jobs;
    };

    const runFetch = (job: FetchJob): Promise<unknown> =>
      createMetaInboundService({
        db: runtime.db,
        storage,
        log: silentLogger,
        keyring: createKeyring(envFor()),
        graph: graphClient,
      })
        .mediaFetch({
          name: 'meta.media_fetch',
          id: job.jobId,
          data: job.payload,
          attemptsMade: 0,
          opts: { attempts: 5 },
        } as unknown as Job)
        .then(
          () => undefined,
          (error: unknown) => error,
        );

    /** `attachment.uploaded` rows of these attachments, run through `media.process`. */
    const processUploads = async (ids: ReadonlySet<string>): Promise<void> => {
      const process = createJobProcessor(
        mediaProcessJob,
        createMediaProcessor({
          storage,
          tools: createMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }),
          scanner: undefined,
        }),
        { db: runtime.db, log: silentLogger },
      );
      const rows = await owner.db
        .select()
        .from(outbox)
        .where(eq(outbox.event, 'attachment.uploaded'));
      for (const row of rows) {
        if (handledOutbox.has(row.id) || !ids.has(String(row.payload.attachmentId))) {
          continue;
        }
        handledOutbox.add(row.id);
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
    };

    /** Every file of a ticket fetched and processed, as the worker does after the relay. */
    const pipeline = async (ticketId: string): Promise<unknown[]> => {
      const ids = new Set((await attachmentsOf(ticketId)).map((row) => row.id));
      const errors: unknown[] = [];
      for (const job of await fetchJobsFor(ids)) {
        const error = await runFetch(job);
        if (error !== undefined) {
          errors.push(error);
        }
      }
      await processUploads(ids);
      return errors;
    };

    it('files a photo pending, fetches it from the CDN link without a token, and makes it a WebP', async () => {
      const psid = newPsid();
      const url = graph.serveCdn(`photo-${psid}.jpg`, JPEG, 'image/jpeg');

      await post(pageAttachment({ psid, mid: newMid(), type: 'image', url, text: 'the box' }));

      const [ticket] = await ticketsOf(psid);
      const [message] = await messagesOf(ticket?.id ?? '');
      expect(message?.bodyText).toBe('the box');
      const [pending] = await attachmentsOf(ticket?.id ?? '');
      expect(pending).toMatchObject({
        messageId: message?.id,
        kind: 'image',
        status: 'pending',
        uploaderType: 'contact',
      });
      expect(await mediaEvents(pending?.id ?? '')).toEqual([
        {
          attachmentId: pending?.id,
          accountId: accountA().id,
          ref: { kind: 'cdn_url', url, type: 'image' },
        },
      ]);
      // Meta wants the webhook answered in seconds: the bytes are the job's.
      expect(graph.mediaRequests).toEqual([]);

      expect(await pipeline(ticket?.id ?? '')).toEqual([]);

      const [ready] = await attachmentsOf(ticket?.id ?? '');
      expect(ready).toMatchObject({ status: 'ready', kind: 'image', size: JPEG.length });
      expect(Object.keys(ready?.variants ?? {})).toContain('webp');
      const webp = await storage.read(`brands/${BRAND_A}/tickets/${ticket?.id}/${ready?.id}/webp`);
      expect((await sharp(webp).metadata()).format).toBe('webp');
      // A CDN link is public: the Page's token must not travel to it.
      expect(graph.mediaRequests).toEqual([
        expect.objectContaining({ kind: 'cdn', authorization: null }),
      ]);
    });

    it.each([
      ['video', 'clip-1.mp4', 'video'],
      ['audio', 'voice-1.mp4', 'audio'],
      ['file', 'invoice-1.pdf', 'file'],
    ] as const)(
      'files a %s as a pending attachment and asks for its fetch, fetching nothing',
      async (type, name, kind) => {
        const psid = newPsid();
        const url = urlOf(name);

        await post(pageAttachment({ psid, mid: newMid(), type, url, text: 'Here you go' }));

        const [ticket] = await ticketsOf(psid);
        const [message] = await messagesOf(ticket?.id ?? '');
        expect(message?.bodyText).toBe('Here you go');
        const rows = await attachmentsOf(ticket?.id ?? '');
        expect(rows).toMatchObject([
          { messageId: message?.id, kind, status: 'pending', uploaderType: 'contact' },
        ]);
        expect(await mediaEvents(rows[0]?.id ?? '')).toEqual([
          {
            attachmentId: rows[0]?.id,
            accountId: accountA().id,
            ref: { kind: 'cdn_url', url, type },
          },
        ]);
        // Meta wants the webhook answered in seconds: the bytes are the job's.
        expect(graph.mediaRequests).toEqual([]);
        expect(graph.calls).toEqual([]);
      },
    );

    it('files a sticker as an image', async () => {
      const psid = newPsid();
      const url = urlOf('sticker-369239263222822.png');

      await post(pageSticker({ psid, mid: newMid(), url }));

      const [ticket] = await ticketsOf(psid);
      const rows = await attachmentsOf(ticket?.id ?? '');
      expect(rows).toMatchObject([{ kind: 'image', status: 'pending' }]);
      expect(await mediaEvents(rows[0]?.id ?? '')).toMatchObject([
        { ref: { kind: 'cdn_url', url, type: 'sticker' } },
      ]);
    });

    it('files a link Messenger could not render as a text line with its URL', async () => {
      const psid = newPsid();

      await post(
        pageFallback({ psid, mid: newMid(), url: 'https://maps.example.com/?q=52.52,13.405' }),
      );

      const [ticket] = await ticketsOf(psid);
      const [message] = await messagesOf(ticket?.id ?? '');
      expect(message?.bodyText).toBe('Brandenburg Gate\nhttps://maps.example.com/?q=52.52,13.405');
      expect(await attachmentsOf(ticket?.id ?? '')).toEqual([]);
    });

    it('says something is missing for a link with no URL, where the conversation has a ticket, and files nothing where it has none', async () => {
      const stranger = newPsid();
      await post(pageFallback({ psid: stranger, mid: newMid(), url: null }));
      expect(await contactsOf(stranger)).toEqual([]);
      expect(await ticketsOf(stranger)).toEqual([]);

      const { psid, ticket } = await customerWhoWrote();
      const mid = newMid();
      await post(pageFallback({ psid, mid, url: null }));

      expect(await systemLines(ticket.id)).toEqual([
        'The customer sent something that cannot be shown here.',
      ]);
      // Redelivered, the line is not written twice.
      await post(pageFallback({ psid, mid, url: null }));
      expect(await systemLines(ticket.id)).toHaveLength(1);
      expect((await messagesOf(ticket.id)).filter((row) => row.kind === 'public')).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------- echoes

  describe('an echo', () => {
    const filedState = async (ticketId: string) => ({
      messages: (await messagesOf(ticketId)).length,
      contacts: (await owner.db.select({ id: contacts.id }).from(contacts)).length,
      tickets: (await owner.db.select({ id: tickets.id }).from(tickets)).length,
    });

    it('of a Helpdock send, named by the delivery in its metadata, files nothing', async () => {
      const { psid, ticket, conversation } = await customerWhoWrote();
      const delivery = await agentReply(conversation, ticket.id, META_FIXTURE.time + 10, newMid());
      const before = await filedState(ticket.id);

      await post(pageEcho({ psid, mid: newMid(), appId: '999', metadata: delivery.id }));

      expect(await filedState(ticket.id)).toEqual(before);
      expect(await conversationOf(psid)).toMatchObject({
        lastInboundMessageId: conversation.lastInboundMessageId,
        lastInboundAt: conversation.lastInboundAt,
      });
    });

    it('of a Helpdock send, named by the install’s app id, files nothing', async () => {
      const { psid, ticket } = await customerWhoWrote();
      const before = await filedState(ticket.id);

      await post(pageEcho({ psid, mid: newMid(), appId: META_FIXTURE.appId }));

      expect(await filedState(ticket.id)).toEqual(before);
    });

    it('typed in the Page inbox, or sent by another app, is dropped too', async () => {
      const { psid, ticket } = await customerWhoWrote();
      const before = await filedState(ticket.id);

      await post(
        pageEcho({ psid, mid: newMid(), appId: OTHER_APPS_ID, text: 'Typed in the inbox' }),
      );
      // A delivery id that belongs to nobody here is not a Helpdock send either.
      await post(pageEcho({ psid, mid: newMid(), appId: OTHER_APPS_ID, metadata: uuidv7() }));

      expect(await filedState(ticket.id)).toEqual(before);
    });

    it('opens no conversation for a customer the Page only wrote to', async () => {
      const psid = newPsid();
      const before = (await owner.db.select({ id: tickets.id }).from(tickets)).length;

      await post(pageEcho({ psid, mid: newMid(), appId: OTHER_APPS_ID }));

      expect(await contactsOf(psid)).toEqual([]);
      expect((await owner.db.select({ id: tickets.id }).from(tickets)).length).toBe(before);
    });
  });

  // --------------------------------------------------------------- receipts

  describe('delivery and read reports', () => {
    it('mark the two earlier deliveries of the conversation and not the later one', async () => {
      const { psid, ticket, conversation } = await customerWhoWrote();
      const base = META_FIXTURE.time + 1_000;
      const first = await agentReply(conversation, ticket.id, base + 10, newMid());
      const second = await agentReply(conversation, ticket.id, base + 20, newMid());
      const third = await agentReply(conversation, ticket.id, base + 60, newMid());

      await post(pageDelivery({ psid, watermark: base + 30 }));

      expect(await deliveryRow(first.id)).toMatchObject({
        status: 'delivered',
        deliveredAt: at(base + 30),
      });
      expect(await deliveryRow(second.id)).toMatchObject({ status: 'delivered' });
      expect(await deliveryRow(third.id)).toMatchObject({ status: 'sent', deliveredAt: null });
    });

    it('mark read through the read watermark, and a late delivery report leaves read as it is', async () => {
      const { psid, ticket, conversation } = await customerWhoWrote();
      const base = META_FIXTURE.time + 2_000;
      const first = await agentReply(conversation, ticket.id, base + 10, newMid());
      const second = await agentReply(conversation, ticket.id, base + 20, newMid());

      await post(pageRead({ psid, watermark: base + 15 }));
      // `read` came first: the report that the message arrived is late and must not undo it.
      await post(pageDelivery({ psid, watermark: base + 25 }));

      expect(await deliveryRow(first.id)).toMatchObject({ status: 'read', readAt: at(base + 15) });
      expect(await deliveryRow(second.id)).toMatchObject({ status: 'delivered' });
    });

    it('move a message the delivery names even when the watermark is before it', async () => {
      const { psid, ticket, conversation } = await customerWhoWrote();
      const base = META_FIXTURE.time + 3_000;
      const earlier = await agentReply(conversation, ticket.id, base + 10, newMid());
      const mid = newMid();
      const named = await agentReply(conversation, ticket.id, base + 60, mid);

      await post(pageDelivery({ psid, watermark: base + 25, mids: [mid] }));

      expect(await deliveryRow(earlier.id)).toMatchObject({ status: 'delivered' });
      expect(await deliveryRow(named.id)).toMatchObject({ status: 'delivered' });
    });

    it('leave another conversation’s deliveries alone', async () => {
      const mine = await customerWhoWrote();
      const theirs = await customerWhoWrote();
      const base = META_FIXTURE.time + 4_000;
      const mineDelivery = await agentReply(mine.conversation, mine.ticket.id, base + 10, newMid());
      const theirDelivery = await agentReply(
        theirs.conversation,
        theirs.ticket.id,
        base + 10,
        newMid(),
      );

      await post(pageRead({ psid: mine.psid, watermark: base + 100 }));

      expect((await deliveryRow(mineDelivery.id)).status).toBe('read');
      expect((await deliveryRow(theirDelivery.id)).status).toBe('sent');
    });

    it('from a customer the Page has no conversation with are dropped', async () => {
      const psid = newPsid();

      await post(pageRead({ psid, watermark: META_FIXTURE.time + 5_000 }));
      await post(pageDelivery({ psid, watermark: META_FIXTURE.time + 5_000 }));

      expect(await contactsOf(psid)).toEqual([]);
    });
  });

  // ------------------------------------------------------ lines in a thread

  describe('a reaction, an edit, something Helpdock cannot show', () => {
    it('is, for a reaction on a reply, a system line on the reply’s ticket, once however often it arrives', async () => {
      const { psid, ticket, conversation } = await customerWhoWrote();
      const replyMid = newMid();
      await agentReply(conversation, ticket.id, META_FIXTURE.time + 10, replyMid);
      const reaction = pageReaction({ psid, mid: replyMid, emoji: '❤️' });

      await post(reaction);
      await post(reaction);

      expect(await systemLines(ticket.id)).toEqual(['The customer reacted ❤️ to a message.']);
      const lines = (await messagesOf(ticket.id)).filter((row) => row.kind === 'system');
      expect(lines).toMatchObject([
        {
          authorType: 'system',
          authorId: `meta:${accountA().id}`,
          channel: 'messenger',
          bodyHtml: '<p>The customer reacted ❤️ to a message.</p>',
        },
      ]);
      // A reaction is never a customer message: it is not the anchor of the reply window.
      expect(await conversationOf(psid)).toMatchObject({
        lastInboundMessageId: conversation.lastInboundMessageId,
      });
      expect((await messagesOf(ticket.id)).filter((row) => row.kind === 'public')).toHaveLength(2);
    });

    it('is, for a reaction on the customer’s own message, a line on that ticket, and a taken-back reaction a second', async () => {
      const { psid, mid, ticket } = await customerWhoWrote();

      await post(pageReaction({ psid, mid, emoji: '👍' }));
      await post(pageReaction({ psid, mid, action: 'unreact', timestamp: META_FIXTURE.time + 5 }));

      expect(await systemLines(ticket.id)).toEqual([
        'The customer reacted 👍 to a message.',
        'The customer removed their reaction to a message.',
      ]);
    });

    it('is written in the contact’s language', async () => {
      const { psid, mid, ticket } = await customerWhoWrote();
      await owner.db
        .update(contacts)
        .set({ locale: 'ar' })
        .where(eq(contacts.id, ticket.contactId ?? ''));

      await post(pageReaction({ psid, mid, emoji: '😮' }));

      expect(await systemLines(ticket.id)).toEqual(['تفاعل العميل بـ 😮 مع رسالة.']);
    });

    it('is nothing for a reaction on a ticket that is closed: the line would be the only thing in a thread nobody opens', async () => {
      const { psid, mid, ticket } = await customerWhoWrote();
      await closeTicket(ticket.id, new Date());

      await post(pageReaction({ psid, mid, emoji: '👍' }));

      expect(await systemLines(ticket.id)).toEqual([]);
    });

    it('is nothing for a reaction on a message Helpdock never filed or sent', async () => {
      const { psid, ticket } = await customerWhoWrote();

      await post(pageReaction({ psid, mid: newMid() }));

      expect(await systemLines(ticket.id)).toEqual([]);
    });

    it('is, for an edit, a line with the new words, and the message keeps what it said', async () => {
      const { psid, mid, ticket } = await customerWhoWrote('Order 78 is late');

      await post(pageEdit({ psid, mid, text: 'Order 77 is late <b>please</b>', numEdit: 1 }));
      await post(pageEdit({ psid, mid, text: 'Order 77 is late <b>please</b>', numEdit: 1 }));

      expect(await systemLines(ticket.id)).toEqual([
        'The customer edited a message. It now reads: Order 77 is late <b>please</b>',
      ]);
      const lines = (await messagesOf(ticket.id)).filter((row) => row.kind === 'system');
      expect(lines[0]?.bodyHtml).toBe(
        '<p>The customer edited a message. It now reads: Order 77 is late &lt;b&gt;please&lt;/b&gt;</p>',
      );
      expect((await messagesOf(ticket.id))[0]?.bodyText).toBe('Order 78 is late');
    });

    it('is, for a message Messenger will not describe, a line where the conversation has a ticket', async () => {
      const { psid, ticket } = await customerWhoWrote();
      const mid = newMid();
      const body = pageText({ psid, mid, timestamp: META_FIXTURE.time + 30 }) as {
        entry: { messaging: { message: Record<string, unknown> }[] }[];
      };
      const message = body.entry[0]?.messaging[0]?.message;
      if (message === undefined) {
        throw new Error('the fixture has no message');
      }
      message.text = '';
      message.is_unsupported = true;

      await post(body);

      expect(await systemLines(ticket.id)).toEqual([
        'The customer sent something that cannot be shown here.',
      ]);
      // The customer did write: Meta will take an answer, so the window follows.
      expect(await conversationOf(psid)).toMatchObject({
        lastInboundMessageId: mid,
        lastInboundAt: at(META_FIXTURE.time + 30),
      });
    });
  });

  // ------------------------------------------------------- counted, dropped

  describe('what Helpdock does not file', () => {
    const resetHealth = (): Promise<unknown> =>
      owner.db
        .update(metaAccounts)
        .set({ lastError: null, lastErrorAt: null })
        .where(eq(metaAccounts.id, accountA().id));

    const policyNotice = (notice: Record<string, string>): MetaWebhookBody => ({
      object: 'page',
      entry: [
        {
          id: PAGE_A,
          time: META_FIXTURE.time * 1_000,
          messaging: [{ 'policy-enforcement': notice }],
        },
      ],
    });

    it('counts a postback, a referral and an event of the other app holding the thread, and files nothing', async () => {
      const { psid, ticket } = await customerWhoWrote();
      await resetHealth();
      const before = (await messagesOf(ticket.id)).length;

      await post(pagePostback({ psid }));
      await post({
        object: 'page',
        entry: [
          {
            id: PAGE_A,
            time: META_FIXTURE.time * 1_000,
            messaging: [{ sender: { id: psid }, referral: { source: 'SHORTLINK', ref: 'spring' } }],
          },
        ],
      });
      await post({
        object: 'page',
        entry: [
          {
            id: PAGE_A,
            time: META_FIXTURE.time * 1_000,
            standby: [
              {
                sender: { id: psid },
                recipient: { id: PAGE_A },
                message: { mid: newMid(), text: 'Hi' },
              },
            ],
          },
        ],
      });

      expect((await messagesOf(ticket.id)).length).toBe(before);
      expect((await accountRow()).lastError).toBeNull();
    });

    it('records messaging policy enforcement on the account, which reads failing until the next event', async () => {
      await resetHealth();

      await post(policyNotice({ action: 'block', reason: 'Messaging policy violation' }));

      const blocked = await accountRow();
      expect(blocked.lastError).toBe(
        'messaging_policy_enforcement block: Messaging policy violation',
      );
      expect(
        metaAccountHealth({
          status: blocked.status,
          lastEventAt: blocked.lastEventAt,
          lastErrorAt: blocked.lastErrorAt,
        }),
      ).toBe('failing');

      await post(pageText({ psid: newPsid(), mid: newMid(), text: 'Anyone home?' }));
      const recovered = await accountRow();
      expect(
        metaAccountHealth({
          status: recovered.status,
          lastEventAt: recovered.lastEventAt,
          lastErrorAt: recovered.lastErrorAt,
        }),
      ).toBe('healthy');
    });

    it('does not record an unblock as an error', async () => {
      await resetHealth();

      await post(policyNotice({ action: 'unblock', reason: 'Messaging restored' }));

      expect((await accountRow()).lastError).toBeNull();
    });
  });
});
