import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GraphClient, type GraphJsonRequest } from '@helpdock/channels';
import {
  FakeGraph,
  instagramSeen,
  MetaWebhookDriver,
  pageDelivery,
  pageRead,
  whatsappStatus,
} from '@helpdock/channels/testing';
import { createKeyring, decodeMasterKey, type Env, encryptSecret } from '@helpdock/config';
import {
  attachments,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  type DbTransaction,
  departments,
  type MetaAccount,
  type MetaDelivery,
  metaAccounts,
  metaConversations,
  metaDeliveries,
  outbox,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import {
  createQueueConnection,
  type MetaSendPayload,
  metaSendJob,
  QUEUE_NAMES,
  silentLogger,
} from '@helpdock/jobs';
import type {
  ErrorResponse,
  MetaDeliveryList,
  MetaPlatform,
  MetaTicketContextResponse,
} from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { DelayedError, type Job, Queue, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { objectKeyBeside } from '../media/keys.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { FakeStorage } from '../testing/media.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { createOutboxDrain, type OutboxDrain } from '../testing/meta-outbox.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { MetaRepository } from './meta.repository.js';
import { createMetaReplyEventHandler, META_EVENTS } from './meta-events.js';
import { paceKey } from './meta-pacing.js';
import { MetaReplyHook } from './meta-reply.hook.js';
import { createMetaSendHandler, createMetaSendProcessor } from './meta-send.job.js';
import { OutboundMetaService } from './outbound-meta.service.js';

/**
 * M10-06 against real Postgres and Redis, with the stand-in for Graph
 * (`FakeGraph`) and the signed-webhook driver of M10-01: an agent's reply to a
 * WhatsApp, Messenger or Instagram customer.
 *
 * The worker is played by hand, one outbox row at a time, as the Telegram and
 * email suites do: the reply goes through the real route and the real hook, the
 * outbox row it wrote becomes a `meta.send` job through the real event handler,
 * and the real processor runs it. Pacing waits are not slept: a job that moves
 * itself to delayed has the customer's pacing key cleared and is run again, and
 * that the delay was asked for is asserted. One test runs a real BullMQ worker
 * and waits the six seconds out.
 *
 * The inbound services are M10-03 to M10-05's, the module's own: a delivery or
 * read report goes through the signed webhook into the real handler, so the ids
 * and times the send job records are proved to be the ones Meta's reports name.
 */

const MASTER_KEY = Buffer.alloc(32, 43).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const APP_SECRET = 'integration-app-secret';

const NUMBER = '106540352242922';
/** The business account the stand-in requires a WhatsApp number to belong to. */
const WABA_ID = '105027842193350';
const PAGE = '112233445566778';
const INSTAGRAM = '17841400000000000';

const TOKEN = {
  whatsapp: 'EAAGwhatsapptoken00000000001',
  messenger: 'EAAGmessengertoken000000002',
  instagram: 'IGAAinstagramtoken0000000004',
} as const;

/** The seeded admin is "Dev Admin" and the seeded brand "Helpdock Dev" (`metaOpeningLine`). */
const OPENING = 'Dev · Helpdock Dev';

const HOUR = 3_600_000;
const MINUTE = 60_000;

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M10-06 Meta reply integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

/** The stand-in's client, which counts the sends and can be told what to do before one. */
class TestGraph extends GraphClient {
  readonly timings: { start: number; end: number }[] = [];
  beforeMessage: ((count: number) => void) | undefined;
  #messages = 0;

  override async post(requestPath: string, request: GraphJsonRequest): Promise<unknown> {
    if (!requestPath.endsWith('/messages')) {
      return super.post(requestPath, request);
    }
    this.#messages += 1;
    this.beforeMessage?.(this.#messages);
    const start = Date.now();
    try {
      return await super.post(requestPath, request);
    } finally {
      this.timings.push({ start, end: Date.now() });
    }
  }

  forget(): void {
    this.#messages = 0;
    this.timings.length = 0;
    this.beforeMessage = undefined;
  }
}

/** What a run of one `meta.send` job came to. */
interface Ran {
  readonly outboxId: string;
  readonly jobId: string;
  readonly payload: MetaSendPayload;
  readonly outcome: 'done' | 'failed';
  readonly error: unknown;
  /** Every time the job moved itself to delayed, as the time it asked to be run again. */
  readonly delays: readonly number[];
}

interface SeededConversation {
  readonly ticketId: string;
  readonly conversationId: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly contactId: string;
}

describe.skipIf(!hasDocker)('replies (M10-06)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let storage: FakeStorage;
  let redis: Redis;
  let driver: MetaWebhookDriver;
  let support: string;
  let billing: string;
  let openStatus: string;
  let ada: Person;
  let sam: Person;
  let bo: Person;
  const graph = new FakeGraph();
  let client: TestGraph;
  const repository = new MetaRepository();
  const accounts = new Map<string, MetaAccount>();
  const handled = new Set<string>();
  let drain: OutboxDrain;
  /** The time the send job believes it is, when a test needs it to be later than it is. */
  const clock: { now: Date | null } = { now: null };
  let counter = 0;

  const envFor = (): Env =>
    metaEnv({ masterKey: MASTER_KEY, postgres, redis: redisContainer, graph });

  const call = <T>(
    method: 'GET' | 'POST',
    url: string,
    who: Person,
    payload?: unknown,
  ): Promise<{ status: number; body: T }> =>
    app
      .inject({
        method,
        url,
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

  /** The refusal a 409 carries: `error.meta` of the body. */
  const refusalOf = (response: { body: unknown }) => (response.body as ErrorResponse).error.meta;

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
      passwordHash: await new PasswordHasher(masterKey).hash(AGENT_PASSWORD),
    });
    return { id, email, token: '' };
  };

  const inBrand = <T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    withSystem(runtime.db, seeded.brandId, fn);

  // ------------------------------------------------------------ the stand-in's side

  /** A connected account of `platform`: a row with its token sealed, and the account in the stand-in. */
  const connect = async (
    platform: MetaPlatform,
    externalId: string,
    token: string,
    options: { humanAgentEnabled?: boolean } = {},
  ): Promise<MetaAccount> => {
    graph.connect({
      platform,
      id: externalId,
      name: `Acme ${platform}`,
      token,
      ...(platform === 'whatsapp' ? { displayPhone: '+1 555 0142', wabaId: WABA_ID } : {}),
      ...(platform === 'instagram' ? { username: 'acme_support' } : {}),
    });
    const [row] = await inBrand((tx) =>
      tx
        .insert(metaAccounts)
        .values({
          brandId: seeded.brandId,
          platform,
          departmentId: support,
          externalId,
          displayName: `Acme ${platform}`,
          ...(platform === 'whatsapp' ? { displayPhone: '+1 555 0142', wabaId: WABA_ID } : {}),
          ...(platform === 'instagram' ? { username: 'acme_support' } : {}),
          accessToken: encryptSecret(token, createKeyring(envFor())),
          tokenKind:
            platform === 'whatsapp'
              ? 'system_user'
              : platform === 'messenger'
                ? 'page'
                : 'instagram_user',
          tokenUpdatedAt: new Date(),
          humanAgentEnabled: options.humanAgentEnabled ?? false,
        })
        .returning(),
    );
    if (row === undefined) {
      throw new Error('the account was not inserted');
    }
    accounts.set(externalId, row);
    return row;
  };

  const accountRow = async (id: string): Promise<MetaAccount> => {
    const [row] = await owner.db.select().from(metaAccounts).where(eq(metaAccounts.id, id));
    if (row === undefined) {
      throw new Error('the account is gone');
    }
    return row;
  };

  /**
   * A ticket on `platform` with its conversation, as M10-03 to M10-05 will leave
   * one: a contact, the customer's first message and the window's anchor
   * `lastInboundAgoMs` ago (null: the customer never wrote).
   */
  const converse = async (input: {
    account: MetaAccount;
    customerId: string;
    waId?: string;
    lastInboundAgoMs: number | null;
    locale?: 'en' | 'ar';
  }): Promise<SeededConversation> => {
    counter += 1;
    const { account } = input;
    return inBrand(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({
          brandId: seeded.brandId,
          name: `Customer ${String(counter)}`,
          ...(input.locale === undefined ? {} : { locale: input.locale }),
        })
        .returning({ id: contacts.id });
      const contactId = contact?.id ?? '';
      const [ticket] = await tx
        .insert(tickets)
        .values({
          brandId: seeded.brandId,
          departmentId: support,
          number: 1_000 + counter,
          prefix: 'HD',
          subject: 'Where is my order?',
          statusId: openStatus,
          channel: account.platform,
          contactId,
        })
        .returning({ id: tickets.id });
      const ticketId = ticket?.id ?? '';
      await tx.insert(ticketMessages).values({
        brandId: seeded.brandId,
        ticketId,
        departmentId: support,
        seq: 1,
        kind: 'public',
        authorType: 'contact',
        bodyHtml: '<p>Where is my order?</p>',
        bodyText: 'Where is my order?',
        channel: account.platform,
      });
      const conversation = await repository.upsertConversation(tx, {
        brandId: seeded.brandId,
        accountId: account.id,
        customerId: input.customerId,
        contactId,
        waId: input.waId ?? null,
        profileName: null,
        username: null,
        inbound:
          input.lastInboundAgoMs === null
            ? null
            : {
                at: new Date(Date.now() - input.lastInboundAgoMs),
                messageId: `in-${String(counter)}`,
              },
      });
      await repository.setConversationTicket(tx, conversation.id, ticketId);
      // Meta knows it too, so the stand-in judges a send by the windows of a real platform.
      if (input.lastInboundAgoMs !== null) {
        graph.lastCustomerMessage.set(
          input.waId ?? input.customerId,
          new Date(Date.now() - input.lastInboundAgoMs),
        );
      }

      return {
        ticketId,
        conversationId: conversation.id,
        customerId: input.customerId,
        accountId: account.id,
        contactId,
      };
    });
  };

  /**
   * The assistant's message on a ticket, handed to the hook as `auto-reply.job.ts`
   * hands it: after the row is written, with no question asked first about the
   * window. Returns the message's id.
   */
  const assistantSays = (ticketId: string, channel: MetaPlatform): Promise<string> =>
    inBrand(async (tx) => {
      const [message] = await tx
        .insert(ticketMessages)
        .values({
          brandId: seeded.brandId,
          ticketId,
          departmentId: support,
          seq: 50,
          kind: 'ai',
          authorType: 'ai',
          bodyHtml: '<p>Can I help?</p>',
          bodyText: 'Can I help?',
          channel,
        })
        .returning({ id: ticketMessages.id });
      const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, ticketId));
      if (ticket === undefined || message === undefined) {
        throw new Error('the seed did not land');
      }
      await new MetaReplyHook(new OutboundMetaService(repository)).onStaffPublicReply(tx, {
        brandId: seeded.brandId,
        ticket,
        messageId: message.id,
      });

      return message.id;
    });

  /** A staff reply through the real route. */
  const reply = (
    ticketId: string,
    html: string,
    extra: { attachmentIds?: string[]; kind?: 'public' | 'note'; who?: Person } = {},
  ) =>
    call<{ id: string }>(
      'POST',
      `/api/brands/${seeded.brandId}/tickets/${ticketId}/messages`,
      extra.who ?? ada,
      { kind: extra.kind ?? 'public', bodyHtml: html, attachmentIds: extra.attachmentIds },
    );

  const deliveriesOf = (ticketId: string): Promise<MetaDelivery[]> =>
    owner.db
      .select()
      .from(metaDeliveries)
      .where(eq(metaDeliveries.ticketId, ticketId))
      .orderBy(metaDeliveries.createdAt);

  const onlyDelivery = async (ticketId: string): Promise<MetaDelivery> => {
    const rows = await deliveriesOf(ticketId);
    expect(rows).toHaveLength(1);
    return rows[0] as MetaDelivery;
  };

  const deliveryById = async (id: string): Promise<MetaDelivery> => {
    const [row] = await owner.db.select().from(metaDeliveries).where(eq(metaDeliveries.id, id));
    if (row === undefined) {
      throw new Error('the delivery is gone');
    }
    return row;
  };

  const outboxRowsFor = (deliveryId: string) =>
    owner.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          eq(outbox.event, META_EVENTS.reply),
          sql`${outbox.payload} ->> 'deliveryId' = ${deliveryId}`,
        ),
      );

  /** An uploaded file the pipeline has finished with, in the bucket and on the row. */
  const attach = async (
    ticketId: string,
    input: {
      name: string;
      kind: 'image' | 'file' | 'audio' | 'video';
      mime: string;
      variant: 'original' | 'webp' | 'opus';
      bytes: Buffer;
      status?: 'ready' | 'processing';
    },
  ): Promise<string> => {
    const id = uuidv7();
    const s3Key = `brands/${seeded.brandId}/tickets/${ticketId}/${id}/original`;
    const status = input.status ?? 'ready';
    await storage.put(objectKeyBeside(s3Key, input.variant), input.bytes);
    await owner.db.insert(attachments).values({
      id,
      brandId: seeded.brandId,
      departmentId: support,
      ticketId,
      uploaderType: 'staff',
      uploaderId: ada.id,
      s3Key,
      originalName: input.name,
      mime: input.mime,
      size: input.bytes.length,
      kind: input.kind,
      status,
      variants:
        status === 'ready'
          ? { [input.variant]: { mime: input.mime, size: input.bytes.length } }
          : {},
    });
    return id;
  };

  // --------------------------------------------------------------- the worker's side

  const processorAt = (now: Date | null) => {
    const clockNow = () => now ?? new Date();
    return createMetaSendProcessor({
      db: runtime.db,
      log: silentLogger,
      repository,
      now: clockNow,
      handler: createMetaSendHandler({
        db: runtime.db,
        repository,
        keyring: createKeyring(envFor()),
        graph: client,
        storage,
        redis,
        locales: new TicketLifecycleRepository(),
        now: clockNow,
      }),
    });
  };

  const clearPace = async (): Promise<void> => {
    const keys = await redis.keys('meta.pace:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  };

  /** One `meta.send` job as BullMQ would hand it over, with `moveToDelayed` recorded. */
  const jobOf = (jobId: string, payload: MetaSendPayload, attemptsMade: number) => {
    const delays: number[] = [];
    const job = {
      id: jobId,
      name: metaSendJob.name,
      data: payload,
      attemptsMade,
      opts: { attempts: metaSendJob.options.attempts },
      moveToDelayed: async (until: number) => {
        delays.push(until);
      },
    } as unknown as Job;
    return { job, delays };
  };

  /**
   * Runs a job to the end: a job that moves itself to delayed has the pacing
   * waited out (the key cleared) and runs again, which is what BullMQ does after
   * the delay, until it finishes or fails.
   */
  const run = async (
    outboxId: string,
    jobId: string,
    payload: MetaSendPayload,
    options: { attemptsMade?: number; autoPace?: boolean } = {},
  ): Promise<Ran> => {
    const { job, delays } = jobOf(jobId, payload, options.attemptsMade ?? 0);
    const process = processorAt(clock.now);
    for (let round = 0; round < 20; round += 1) {
      try {
        await process(job, 'lock-token');
        return { outboxId, jobId, payload, outcome: 'done', error: undefined, delays };
      } catch (error) {
        if (error instanceof DelayedError && options.autoPace !== false) {
          await clearPace();
          continue;
        }
        return { outboxId, jobId, payload, outcome: 'failed', error, delays };
      }
    }
    throw new Error('the job kept waiting for its turn');
  };

  /** The `meta.reply` rows nobody has handled yet, each run as the job it asks for. */
  const runNew = async (options: { attemptsMade?: number; autoPace?: boolean } = {}) => {
    const rows = await drain.drain<MetaSendPayload>(META_EVENTS.reply, createMetaReplyEventHandler);
    const ran: Ran[] = [];
    for (const row of rows) {
      const [job] = row.jobs;
      if (job === undefined) {
        throw new Error('the event handler added no job');
      }
      ran.push(await run(row.id, job.jobId, job.payload, options));
    }
    return ran;
  };

  /** The same job again, as after a crash between the send and the acknowledgement. */
  const again = (ran: Ran, options: { attemptsMade?: number } = {}) =>
    run(ran.outboxId, ran.jobId, ran.payload, options);

  const sentOn = (platform: MetaPlatform, to: string) =>
    graph.sentTo(to).filter((message) => message.platform === platform);

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis(), graph.start()]);
    client = new TestGraph({
      root: graph.facebookRoot,
      instagramRoot: graph.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
    });

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-meta-replies-')));
    app = await createApiApp({
      runtime,
      objectStorage: storage,
      // The inbound services are the module's own: a delivery or read report goes through
      // the signed webhook into the real handler, which reads what the send job wrote.
      meta: { graph: client },
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    drain = createOutboxDrain({ db: runtime.db, owner: owner.db, handled });
    redis = createQueueConnection(redisContainer.getConnectionUrl());
    driver = new MetaWebhookDriver({ target: app, secret: APP_SECRET });
    await runtime.settings.set('meta.appSecret', APP_SECRET, { updatedBy: 'suite' });

    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');
    bo = await addPerson(runtime.db, 'bo');
    await inBrand(async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });
      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';
      const [open] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, 'Open'));
      openStatus = open?.id ?? '';
      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
      ]);
    });
    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });
    sam.token = await signInForTest(app, { email: sam.email, password: AGENT_PASSWORD });
    bo.token = await signInForTest(app, { email: bo.email, password: AGENT_PASSWORD });

    await connect('whatsapp', NUMBER, TOKEN.whatsapp);
    await connect('messenger', PAGE, TOKEN.messenger);
    await connect('instagram', INSTAGRAM, TOKEN.instagram);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await redis?.quit();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // A failure inside the stand-in reads to Helpdock as Meta being down, and a retry test would
  // pass on it: it is said here, in the test it happened in.
  afterEach(() => {
    expect(graph.errors).toEqual([]);
  });

  beforeEach(async () => {
    graph.reset();
    client.forget();
    clock.now = null;
    await clearPace();
    // Whatever an earlier test left queued is not this test's to send.
    const leftovers = await owner.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.event, META_EVENTS.reply));
    for (const row of leftovers) {
      handled.add(row.id);
    }
  });

  // ------------------------------------------------------------ the exit criterion

  describe('a reply from the ticket', () => {
    it.each([
      ['whatsapp', NUMBER, TOKEN.whatsapp],
      ['messenger', PAGE, TOKEN.messenger],
      ['instagram', INSTAGRAM, TOKEN.instagram],
    ] as const)(
      'reaches the customer on %s once when the job runs twice, and the reports move it to delivered and read (exit criterion)',
      async (platform, externalId, token) => {
        const account = accounts.get(externalId) as MetaAccount;
        const waId = '16505550111';
        const customer =
          platform === 'whatsapp'
            ? await converse({
                account,
                customerId: 'US.13491208655302741918',
                waId,
                lastInboundAgoMs: 2 * HOUR,
              })
            : await converse({
                account,
                customerId: platform === 'messenger' ? '5001' : '6001',
                lastInboundAgoMs: 2 * HOUR,
              });
        // WhatsApp is written to by number when Meta sent one.
        const recipient = platform === 'whatsapp' ? waId : customer.customerId;

        const response = await reply(
          customer.ticketId,
          '<p>Sorry about that.</p><p>It ships today.</p>',
        );
        expect(response.status).toBe(201);
        // Queued with the reply, sent by nobody yet.
        expect(graph.sent).toEqual([]);
        const queued = await onlyDelivery(customer.ticketId);
        expect(queued).toMatchObject({ status: 'queued', customerId: customer.customerId });
        expect(await outboxRowsFor(queued.id)).toHaveLength(1);

        const [first] = await runNew();
        expect(first?.outcome).toBe('done');
        const second = first === undefined ? undefined : await again(first);
        expect(second?.outcome).toBe('done');

        const sent = sentOn(platform, recipient);
        expect(sent).toHaveLength(1);
        const text = `${OPENING}\nSorry about that.\nIt ships today.`;
        expect(sent[0]?.payload).toEqual(
          platform === 'whatsapp'
            ? {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: waId,
                type: 'text',
                text: { body: text },
              }
            : {
                recipient: { id: customer.customerId },
                messaging_type: 'RESPONSE',
                message: { text, metadata: queued.id },
              },
        );
        // One call, to the right host with the account's own token.
        const posts = graph.callsTo(`/${externalId}/messages`, 'POST');
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({
          root: platform === 'instagram' ? 'instagram' : 'facebook',
          token,
        });

        const sentRow = await onlyDelivery(customer.ticketId);
        expect(sentRow).toMatchObject({ status: 'sent', partsSent: 1, attempts: 0 });
        expect(sentRow.platformMessageIds).toEqual([sent[0]?.id]);
        const messageId = sent[0]?.id ?? '';

        // The platform's reports, through the signed webhook.
        const listPath = `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries`;
        if (platform === 'whatsapp') {
          await driver.post(
            whatsappStatus({
              phoneNumberId: NUMBER,
              wamid: messageId,
              from: waId,
              status: 'delivered',
            }),
          );
        } else if (platform === 'messenger') {
          await driver.post(
            pageDelivery({
              pageId: PAGE,
              psid: customer.customerId,
              mids: [messageId],
              watermark: Math.floor(Date.now() / 1_000),
            }),
          );
        }
        if (platform !== 'instagram') {
          const delivered = await call<MetaDeliveryList>('GET', listPath, sam);
          expect(delivered.body.items).toMatchObject([{ status: 'delivered' }]);
          expect(delivered.body.items[0]?.deliveredAt).not.toBeNull();
        }

        if (platform === 'whatsapp') {
          await driver.post(
            whatsappStatus({ phoneNumberId: NUMBER, wamid: messageId, from: waId, status: 'read' }),
          );
        } else if (platform === 'messenger') {
          await driver.post(
            pageRead({
              pageId: PAGE,
              psid: customer.customerId,
              watermark: Math.floor(Date.now() / 1_000) + 5,
            }),
          );
        } else {
          await driver.post(
            instagramSeen({ igAccountId: INSTAGRAM, igsid: customer.customerId, mid: messageId }),
          );
        }
        const read = await call<MetaDeliveryList>('GET', listPath, sam);
        expect(read.body.items).toMatchObject([{ status: 'read', partsSent: 1, partsTotal: 1 }]);
        expect(read.body.items[0]?.readAt).not.toBeNull();
      },
    );

    it.each([
      ['whatsapp', NUMBER, '16505550131', 1],
      ['messenger', PAGE, '5031', 0],
      ['instagram', INSTAGRAM, '6031', 0],
    ] as const)(
      'sends the text and each attachment once on %s when the job runs twice (exit criterion)',
      async (platform, externalId, customerId, uploadCount) => {
        const account = accounts.get(externalId) as MetaAccount;
        const customer = await converse({
          account,
          customerId,
          ...(platform === 'whatsapp' ? { waId: customerId } : {}),
          lastInboundAgoMs: HOUR,
        });
        const photo = await attach(customer.ticketId, {
          name: 'label.jpg',
          kind: 'image',
          mime: 'image/jpeg',
          variant: 'original',
          bytes: Buffer.from('JPEG bytes'),
        });
        expect(
          (await reply(customer.ticketId, '<p>Here is the label.</p>', { attachmentIds: [photo] }))
            .status,
        ).toBe(201);

        const [first] = await runNew();
        expect(first?.outcome).toBe('done');
        const messages = graph.callsTo(`/${externalId}/messages`, 'POST').length;
        const sentBefore = sentOn(platform, customerId).map((message) => message.id);
        expect(sentBefore).toHaveLength(2);
        expect(graph.uploads.size).toBe(uploadCount);

        // The same job again, as after a crash between the send and the acknowledgement.
        const second = first === undefined ? undefined : await again(first);

        expect(second?.outcome).toBe('done');
        expect(sentOn(platform, customerId).map((message) => message.id)).toEqual(sentBefore);
        expect(graph.callsTo(`/${externalId}/messages`, 'POST')).toHaveLength(messages);
        expect(graph.uploads.size).toBe(uploadCount);
        expect(await onlyDelivery(customer.ticketId)).toMatchObject({
          status: 'sent',
          partsSent: 2,
        });
      },
    );

    it('tells the ticket view who the conversation is with and whether a reply may be written now', async () => {
      const waId = '16505550112';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: 'US.13491208655302741999',
        waId,
        lastInboundAgoMs: 3 * HOUR,
      });
      await inBrand((tx) =>
        tx
          .update(metaConversations)
          .set({ profileName: 'Daniel Reyes' })
          .where(eq(metaConversations.id, customer.conversationId)),
      );

      const read = await call<MetaTicketContextResponse>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta`,
        sam,
      );

      expect(read.status).toBe(200);
      expect(read.body.deliveries).toEqual([]);
      expect(read.body.context).toMatchObject({
        account: {
          id: customer.accountId,
          platform: 'whatsapp',
          externalId: NUMBER,
          displayName: 'Acme whatsapp',
          displayPhone: '+1 555 0142',
        },
        customerId: 'US.13491208655302741999',
        phone: `+${waId}`,
        phoneVerified: true,
        profileName: 'Daniel Reyes',
        window: { state: 'open' },
      });
      const closes = read.body.context?.window;
      expect(closes?.state === 'open' ? Date.parse(closes.closesAt) : 0).toBeGreaterThan(
        Date.now() + 20 * HOUR,
      );
    });

    it('says the window is closed, and when, once the customer has been quiet a day', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5002',
        lastInboundAgoMs: 30 * HOUR,
      });

      const read = await call<MetaTicketContextResponse>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta`,
        sam,
      );

      expect(read.body.context).toMatchObject({
        phoneVerified: false,
        window: { state: 'closed', closedAt: expect.any(String) },
      });
      expect(read.body.context).not.toHaveProperty('phone');
    });

    it('tells the thread which Instagram messages the customer unsent, and which line marks each', async () => {
      const customer = await converse({
        account: accounts.get(INSTAGRAM) as MetaAccount,
        customerId: '6007',
        lastInboundAgoMs: HOUR,
      });
      const message = (seq: number, kind: 'public' | 'system', externalMessageId: string) =>
        inBrand(async (tx) => {
          const [row] = await tx
            .insert(ticketMessages)
            .values({
              brandId: seeded.brandId,
              ticketId: customer.ticketId,
              departmentId: support,
              seq,
              kind,
              authorType: kind === 'system' ? 'system' : 'contact',
              bodyHtml: '<p>x</p>',
              bodyText: 'x',
              channel: 'instagram',
              externalMessageId,
            })
            .returning({ id: ticketMessages.id });
          return row?.id ?? '';
        });
      const original = await message(2, 'public', 'mid.unsent-1');
      const line = await message(3, 'system', 'unsent:mid.unsent-1');
      // A line whose message is not on this ticket marks nothing here.
      await message(4, 'system', 'unsent:mid.elsewhere');

      const read = await call<MetaTicketContextResponse>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta`,
        sam,
      );

      expect(read.status).toBe(200);
      expect(read.body.unsent).toEqual([
        { ticketMessageId: original, lineId: line, at: expect.any(String) },
      ]);
    });

    it('says nothing unsent on a WhatsApp ticket, whatever its lines are called', async () => {
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: 'US.13491208655302741777',
        lastInboundAgoMs: HOUR,
      });
      await inBrand((tx) =>
        tx.insert(ticketMessages).values({
          brandId: seeded.brandId,
          ticketId: customer.ticketId,
          departmentId: support,
          seq: 2,
          kind: 'system',
          authorType: 'system',
          bodyHtml: '<p>x</p>',
          bodyText: 'x',
          channel: 'whatsapp',
          externalMessageId: 'unsent:wamid.1',
        }),
      );

      const read = await call<MetaTicketContextResponse>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta`,
        sam,
      );

      expect(read.body.unsent).toEqual([]);
    });

    it('answers a null context for a ticket on another channel, and 404 for another department’s', async () => {
      const [other] = await inBrand((tx) =>
        tx
          .insert(tickets)
          .values({
            brandId: seeded.brandId,
            departmentId: support,
            number: 9_001,
            prefix: 'HD',
            subject: 'By email',
            statusId: openStatus,
            channel: 'email',
          })
          .returning({ id: tickets.id }),
      );
      const path = (ticketId: string) => `/api/brands/${seeded.brandId}/tickets/${ticketId}/meta`;

      const plain = await call<MetaTicketContextResponse>('GET', path(other?.id ?? ''), sam);
      expect(plain.body).toEqual({ context: null, deliveries: [], unsent: [] });

      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5003',
        lastInboundAgoMs: HOUR,
      });
      expect((await call('GET', path(customer.ticketId), bo)).status).toBe(404);
      expect((await call('GET', `${path(customer.ticketId)}/deliveries`, bo)).status).toBe(404);
    });

    it('cuts an unbroken run of Arabic letters between two letters on Instagram, never inside one', async () => {
      const customer = await converse({
        account: accounts.get(INSTAGRAM) as MetaAccount,
        customerId: '6010',
        lastInboundAgoMs: HOUR,
        locale: 'ar',
      });
      // 700 letters of two bytes each and no space to cut at: the cut must fall between letters.
      const text = 'ط'.repeat(700);

      expect((await reply(customer.ticketId, `<p>${text}</p>`)).status).toBe(201);
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('done');
      const parts = sentOn('instagram', customer.customerId).map(
        (message) => (message.payload as { message: { text: string } }).message.text,
      );
      expect(parts.length).toBeGreaterThanOrEqual(2);
      for (const part of parts) {
        expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(1_000);
        expect(part).not.toContain('�');
      }
      const letters = parts.map((part, index) =>
        index === 0 ? part.slice(OPENING.length + 1) : part,
      );
      expect(letters.join('')).toBe(text);
    });

    it('splits a 1000-byte Arabic reply on Instagram at a letter boundary and sends both parts', async () => {
      const customer = await converse({
        account: accounts.get(INSTAGRAM) as MetaAccount,
        customerId: '6002',
        lastInboundAgoMs: HOUR,
        locale: 'ar',
      });
      // 120 words of five letters: 10 bytes a word and a space, 1,319 bytes in all.
      const words = Array.from({ length: 120 }, () => 'الطلب');
      const text = words.join(' ');
      expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(1_000);

      expect((await reply(customer.ticketId, `<p>${text}</p>`)).status).toBe(201);
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('done');
      const parts = sentOn('instagram', customer.customerId).map(
        (message) => (message.payload as { message: { text: string } }).message.text,
      );
      expect(parts).toHaveLength(2);
      for (const part of parts) {
        expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(1_000);
        // Whole words: no letter was cut.
        expect(part).not.toContain('�');
      }
      // The opening line is on the first part and counts toward its bytes.
      expect(parts[0]?.startsWith(`${OPENING}\n`)).toBe(true);
      expect(parts[1]).not.toContain('Helpdock');
      const bodies = parts.map((part, index) =>
        index === 0 ? part.slice(OPENING.length + 1) : part,
      );
      for (const body of bodies) {
        expect(body.split(' ').every((word) => word === 'الطلب')).toBe(true);
      }
      expect(bodies.join(' ')).toBe(text);
      const delivery = await onlyDelivery(customer.ticketId);
      expect(delivery).toMatchObject({ status: 'sent', partsSent: 2 });
      expect(delivery.platformMessageIds).toHaveLength(2);
    });

    it('opens only the first message of a long reply with the author’s first name and the brand', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5012',
        lastInboundAgoMs: HOUR,
      });
      // Two paragraphs that cannot share a 2000-character message.
      const body = `<p>${'a'.repeat(1_500)}</p><p>${'b'.repeat(1_500)}</p>`;

      expect((await reply(customer.ticketId, body)).status).toBe(201);
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('done');
      const parts = sentOn('messenger', '5012').map(
        (message) => (message.payload as { message: { text: string } }).message.text,
      );
      expect(parts).toEqual([`${OPENING}\n${'a'.repeat(1_500)}`, 'b'.repeat(1_500)]);
    });

    it('sends the opening line as a message of its own when the reply is only files', async () => {
      const waId = '16505550122';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: waId,
        waId,
        lastInboundAgoMs: HOUR,
      });
      const terms = await attach(customer.ticketId, {
        name: 'terms.pdf',
        kind: 'file',
        mime: 'application/pdf',
        variant: 'original',
        bytes: Buffer.from('%PDF-1.7 terms'),
      });

      expect((await reply(customer.ticketId, '<p></p>', { attachmentIds: [terms] })).status).toBe(
        201,
      );
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('done');
      expect(sentOn('whatsapp', waId).map((message) => message.payload)).toEqual([
        expect.objectContaining({ type: 'text', text: { body: OPENING } }),
        expect.objectContaining({ type: 'document' }),
      ]);
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({ partsSent: 2 });
    });

    it('sends two files on WhatsApp as three messages, and resumes after the one that failed', async () => {
      const waId = '16505550113';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: waId,
        waId,
        lastInboundAgoMs: HOUR,
      });
      const photo = await attach(customer.ticketId, {
        name: 'label.jpg',
        kind: 'image',
        mime: 'image/jpeg',
        variant: 'original',
        bytes: Buffer.from('JPEG bytes'),
      });
      const terms = await attach(customer.ticketId, {
        name: 'terms.pdf',
        kind: 'file',
        mime: 'application/pdf',
        variant: 'original',
        bytes: Buffer.from('%PDF-1.7 terms'),
      });
      expect(
        (await reply(customer.ticketId, '<p>Here you are.</p>', { attachmentIds: [photo, terms] }))
          .status,
      ).toBe(201);
      // The third message is refused once, as Graph does when it is briefly down.
      client.beforeMessage = (count) => {
        if (count === 3) {
          graph.failures.push({ status: 503, match: /^POST \/\d+\/messages$/ });
        }
      };

      const [first] = await runNew();

      expect(first?.outcome).toBe('failed');
      expect(first?.error).toMatchObject({ kind: 'retry' });
      const half = await onlyDelivery(customer.ticketId);
      expect(half).toMatchObject({ status: 'queued', partsSent: 2, attempts: 1 });
      expect(half.lastError).toContain('503');
      expect(sentOn('whatsapp', waId)).toHaveLength(2);

      // BullMQ's next attempt sends only what is left.
      client.beforeMessage = undefined;
      const retried = first === undefined ? undefined : await again(first, { attemptsMade: 1 });

      expect(retried?.outcome).toBe('done');
      const sent = sentOn('whatsapp', waId).map((message) => message.payload);
      expect(sent).toEqual([
        expect.objectContaining({ type: 'text', text: { body: `${OPENING}\nHere you are.` } }),
        expect.objectContaining({
          type: 'image',
          image: { id: expect.stringMatching(/^FAKEMEDIA/), caption: 'label.jpg' },
        }),
        expect.objectContaining({
          type: 'document',
          document: { id: expect.stringMatching(/^FAKEMEDIA/), filename: 'terms.pdf' },
        }),
      ]);
      // The photo was uploaded once; the document again, because its send failed.
      const uploads = [...graph.uploads.values()];
      expect(uploads.filter((upload) => upload.name === 'label.jpg')).toHaveLength(1);
      expect(uploads.filter((upload) => upload.name === 'terms.pdf')).toHaveLength(2);
      expect(uploads.find((upload) => upload.name === 'label.jpg')).toMatchObject({
        contentType: 'image/jpeg',
        bytes: Buffer.from('JPEG bytes'),
      });
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'sent',
        partsSent: 3,
        lastError: null,
      });
      const listed = await call<MetaDeliveryList>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries`,
        ada,
      );
      expect(listed.body.items).toMatchObject([{ partsSent: 3, partsTotal: 3, leftOut: [] }]);
    });

    it('hands Messenger a five-minute link for a file, and waits for one still being processed', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5004',
        lastInboundAgoMs: HOUR,
      });
      const invoice = await attach(customer.ticketId, {
        name: 'invoice.pdf',
        kind: 'file',
        mime: 'application/pdf',
        variant: 'original',
        bytes: Buffer.from('%PDF-1.7 invoice'),
        status: 'processing',
      });
      expect(
        (await reply(customer.ticketId, '<p>The invoice.</p>', { attachmentIds: [invoice] }))
          .status,
      ).toBe(201);

      const [waiting] = await runNew();

      expect(waiting?.outcome).toBe('failed');
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'queued',
        partsSent: 1,
        attempts: 1,
      });
      expect(sentOn('messenger', '5004')).toHaveLength(1);

      // The pipeline finishes; the next attempt sends only the file.
      await owner.db
        .update(attachments)
        .set({
          status: 'ready',
          variants: { original: { mime: 'application/pdf', size: 16 } },
        })
        .where(eq(attachments.id, invoice));
      const done = waiting === undefined ? undefined : await again(waiting, { attemptsMade: 1 });

      expect(done?.outcome).toBe('done');
      const sent = sentOn('messenger', '5004');
      expect(sent).toHaveLength(2);
      const delivery = await onlyDelivery(customer.ticketId);
      expect(sent[1]?.payload).toEqual({
        recipient: { id: '5004' },
        messaging_type: 'RESPONSE',
        message: {
          attachment: {
            type: 'file',
            payload: {
              url: expect.stringMatching(/^https:\/\/bucket\.test\//),
              is_reusable: false,
            },
          },
          metadata: delivery.id,
        },
      });
      expect(delivery).toMatchObject({ status: 'sent', partsSent: 2 });
    });

    it('leaves out a file Instagram will not take, tells the customer in their language, and tells the agent', async () => {
      const customer = await converse({
        account: accounts.get(INSTAGRAM) as MetaAccount,
        customerId: '6003',
        lastInboundAgoMs: HOUR,
        locale: 'ar',
      });
      const word = await attach(customer.ticketId, {
        name: 'warranty-terms.docx',
        kind: 'file',
        mime: 'application/msword',
        variant: 'original',
        bytes: Buffer.from('docx bytes'),
      });
      const pdf = await attach(customer.ticketId, {
        name: 'warranty.pdf',
        kind: 'file',
        mime: 'application/pdf',
        variant: 'original',
        bytes: Buffer.from('%PDF-1.7'),
      });
      expect(
        (await reply(customer.ticketId, '<p>Our terms.</p>', { attachmentIds: [word, pdf] }))
          .status,
      ).toBe(201);

      const [ran] = await runNew();

      expect(ran?.outcome).toBe('done');
      const sent = sentOn('instagram', '6003').map((message) => message.payload);
      expect(sent).toHaveLength(3);
      expect(sent[0]).toMatchObject({ message: { text: `${OPENING}\nOur terms.` } });
      // In its place, a line in Arabic that names the file and says what Instagram takes.
      const notice = (sent[1] as { message: { text: string } }).message.text;
      expect(notice).toContain('warranty-terms.docx');
      expect(notice).toContain('PDF');
      expect(notice).toContain('إنستغرام');
      expect(sent[2]).toMatchObject({ message: { attachment: { type: 'file' } } });

      const listed = await call<MetaDeliveryList>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries`,
        ada,
      );
      expect(listed.body.items).toMatchObject([
        {
          status: 'sent',
          partsSent: 3,
          partsTotal: 3,
          leftOut: [
            { attachmentId: word, name: 'warranty-terms.docx', reason: 'unsupported-type' },
          ],
        },
      ]);
    });
  });

  // ------------------------------------------------------------------- the window

  describe('the reply window', () => {
    it('refuses a reply at 24 h 01 m at compose time with reply-window-closed, and writes nothing', async () => {
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: '16505550114',
        waId: '16505550114',
        lastInboundAgoMs: 24 * HOUR + MINUTE,
      });
      const before = await inBrand((tx) =>
        tx
          .select({ id: ticketMessages.id })
          .from(ticketMessages)
          .where(eq(ticketMessages.ticketId, customer.ticketId)),
      );

      const refused = await reply(customer.ticketId, '<p>Sorry for the wait.</p>');

      expect(refused.status).toBe(409);
      expect(refusalOf(refused)).toMatchObject({
        reason: 'reply-window-closed',
        details: {
          platform: 'whatsapp',
          anchorAt: expect.any(String),
          closedAt: expect.any(String),
        },
      });
      // The window closed a minute ago: 24 hours after the customer's last message.
      const details = refusalOf(refused)?.details;
      expect(Date.parse(details?.closedAt ?? '') - Date.parse(details?.anchorAt ?? '')).toBe(
        24 * HOUR,
      );
      // No message, no delivery, no outbox row, and the sequence is where it was.
      const after = await inBrand((tx) =>
        tx
          .select({ id: ticketMessages.id })
          .from(ticketMessages)
          .where(eq(ticketMessages.ticketId, customer.ticketId)),
      );
      expect(after).toEqual(before);
      expect(await deliveriesOf(customer.ticketId)).toEqual([]);
      expect(await runNew()).toEqual([]);

      // An internal note is never refused.
      expect((await reply(customer.ticketId, '<p>Call them.</p>', { kind: 'note' })).status).toBe(
        201,
      );
    });

    it('refuses a reply to a customer who never wrote', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5005',
        lastInboundAgoMs: null,
      });

      const refused = await reply(customer.ticketId, '<p>Hello?</p>');

      expect(refused.status).toBe(409);
      expect(refusalOf(refused)).toMatchObject({
        reason: 'reply-window-closed',
        details: { platform: 'messenger', anchorAt: null, closedAt: null },
      });
    });

    it('queues a reply at 23 h 59 m, and the job at 24 h 01 m refuses it and sends nothing', async () => {
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: '16505550115',
        waId: '16505550115',
        lastInboundAgoMs: 23 * HOUR + 59 * MINUTE,
      });
      expect((await reply(customer.ticketId, '<p>On its way.</p>')).status).toBe(201);
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({ status: 'queued' });

      // The job runs two minutes later, a minute past the window.
      const accountBefore = await accountRow(customer.accountId);
      clock.now = new Date(Date.now() + 2 * MINUTE);
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('failed');
      expect(graph.sent).toEqual([]);
      expect(graph.calls).toEqual([]);
      const refused = await onlyDelivery(customer.ticketId);
      expect(refused).toMatchObject({
        status: 'refused',
        errorCode: '131047',
        partsSent: 0,
        attempts: 0,
      });
      expect(refused.lastError).toEqual(expect.any(String));
      expect(refused.failedAt).not.toBeNull();
      // Nothing is wrong with the connection: the account's last words are as they were.
      const accountAfter = await accountRow(customer.accountId);
      expect(accountAfter.lastError).toBe(accountBefore.lastError);
      expect(accountAfter.lastErrorAt).toEqual(accountBefore.lastErrorAt);

      // Retry is not offered for it, and is refused if asked.
      const retried = await call<unknown>(
        'POST',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries/${refused.id}/retry`,
        ada,
      );
      expect(retried.status).toBe(409);
      expect(refusalOf(retried)).toMatchObject({ reason: 'reply-window-closed' });
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({ status: 'refused' });
      expect(await outboxRowsFor(refused.id)).toHaveLength(1);
    });

    it.each([
      ['messenger', PAGE, '5006'],
      ['instagram', INSTAGRAM, '6006'],
    ] as const)(
      'records the closed window with the code of %s too',
      async (platform, externalId, customerId) => {
        const customer = await converse({
          account: accounts.get(externalId) as MetaAccount,
          customerId,
          lastInboundAgoMs: 23 * HOUR + 59 * MINUTE,
        });
        expect((await reply(customer.ticketId, '<p>On its way.</p>')).status).toBe(201);
        expect(platform).toBe(accounts.get(externalId)?.platform);

        clock.now = new Date(Date.now() + 2 * MINUTE);
        await runNew();

        expect(await onlyDelivery(customer.ticketId)).toMatchObject({
          status: 'refused',
          errorCode: '10/2018278',
        });
        expect(graph.sent).toEqual([]);
      },
    );

    it('is refused by Meta itself when the clocks disagree, and ends refused rather than failed', async () => {
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: '16505550116',
        waId: '16505550116',
        lastInboundAgoMs: HOUR,
      });
      graph.windowClosed.add('16505550116');
      await reply(customer.ticketId, '<p>Hi.</p>');

      const accountBefore = await accountRow(customer.accountId);
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('failed');
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'refused',
        errorCode: '131047',
        attempts: 0,
      });
      expect((await accountRow(customer.accountId)).lastError).toBe(accountBefore.lastError);
    });

    describe('the Human Agent extension (M10-06; the tag shipped here, templates are M10-09)', () => {
      const SEVEN = [
        ['messenger', '112233445568000', 'EAAGmessengertoken000000005', '5007'],
        ['instagram', '17841400000000777', 'IGAAinstagramtoken0000000006', '6007'],
      ] as const;

      it.each(SEVEN)(
        'gives a person seven days on %s with the switch on, sends their reply tagged HUMAN_AGENT on day 3, and gives the assistant none',
        async (platform, externalId, token, customerId) => {
          const account = await connect(platform, externalId, token, { humanAgentEnabled: true });
          const customer = await converse({ account, customerId, lastInboundAgoMs: 72 * HOUR });

          // The ticket view draws the strip from the same function.
          const read = await call<MetaTicketContextResponse>(
            'GET',
            `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta`,
            ada,
          );
          expect(read.body.context?.window.state).toBe('human_agent');
          // A person's reply is written and queued: the window is not closed for them.
          expect((await reply(customer.ticketId, '<p>Following up.</p>')).status).toBe(201);
          const queued = await onlyDelivery(customer.ticketId);
          expect(queued).toMatchObject({ status: 'queued' });

          // The assistant's message, on the same ticket, is not.
          const aiMessageId = await assistantSays(customer.ticketId, platform);
          const rows = await deliveriesOf(customer.ticketId);
          const ai = rows.find((row) => row.ticketMessageId === aiMessageId);
          expect(ai).toMatchObject({ status: 'refused', errorCode: '10/2018278' });
          expect(await outboxRowsFor(ai?.id ?? '')).toEqual([]);

          // The person's reply goes out, with the tag, and the stand-in takes it: day 3 is
          // inside the seven days and well outside the 24 hours a RESPONSE is good for.
          const ran = await runNew();
          expect(ran.map((job) => job.outcome)).toEqual(['done']);
          const sent = sentOn(platform, customerId);
          expect(sent.map((message) => message.payload)).toEqual([
            {
              recipient: { id: customerId },
              messaging_type: 'MESSAGE_TAG',
              tag: 'HUMAN_AGENT',
              message: { text: `${OPENING}\nFollowing up.`, metadata: queued.id },
            },
          ]);
          expect(await deliveryById(queued.id)).toMatchObject({ status: 'sent', partsSent: 1 });
        },
      );

      it('tags every part of a person’s long reply on day 3, and the file after it', async () => {
        const account = await connect(
          'messenger',
          '112233445568001',
          'EAAGmessengertoken000000007',
          {
            humanAgentEnabled: true,
          },
        );
        const customer = await converse({
          account,
          customerId: '5008',
          lastInboundAgoMs: 72 * HOUR,
        });
        const terms = await attach(customer.ticketId, {
          name: 'terms.pdf',
          kind: 'file',
          mime: 'application/pdf',
          variant: 'original',
          bytes: Buffer.from('%PDF-1.7 terms'),
        });
        const body = `<p>${'a'.repeat(1_500)}</p><p>${'b'.repeat(1_500)}</p>`;

        expect((await reply(customer.ticketId, body, { attachmentIds: [terms] })).status).toBe(201);
        const [ran] = await runNew();

        expect(ran?.outcome).toBe('done');
        const sent = sentOn('messenger', '5008').map((message) => message.payload);
        expect(sent).toHaveLength(3);
        expect(sent).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' }),
          ),
        );
      });

      it('sends a reply inside the 24 hours as a RESPONSE, tagged with nothing, even with the switch on', async () => {
        const account = await connect(
          'messenger',
          '112233445568002',
          'EAAGmessengertoken000000008',
          {
            humanAgentEnabled: true,
          },
        );
        const customer = await converse({
          account,
          customerId: '5009',
          lastInboundAgoMs: 2 * HOUR,
        });

        expect((await reply(customer.ticketId, '<p>On it.</p>')).status).toBe(201);
        await runNew();

        const [message] = sentOn('messenger', '5009');
        expect(message?.payload).toMatchObject({ messaging_type: 'RESPONSE' });
        expect(message?.payload).not.toHaveProperty('tag');
      });

      it('refuses a person on day 3 at compose time when the switch is off, and on day 8 when it is on', async () => {
        const off = await converse({
          account: accounts.get(PAGE) as MetaAccount,
          customerId: '5010',
          lastInboundAgoMs: 72 * HOUR,
        });
        const on = await connect('messenger', '112233445568003', 'EAAGmessengertoken000000009', {
          humanAgentEnabled: true,
        });
        const expired = await converse({
          account: on,
          customerId: '5011',
          lastInboundAgoMs: 8 * 24 * HOUR,
        });

        for (const customer of [off, expired]) {
          const refused = await reply(customer.ticketId, '<p>Following up.</p>');

          expect(refused.status).toBe(409);
          expect(refusalOf(refused)).toMatchObject({ reason: 'reply-window-closed' });
        }
        expect(await runNew()).toEqual([]);
        expect(graph.sent).toEqual([]);
      });

      it('is refused by Meta itself, and ends refused rather than failed, when the seven days run out while the job waits', async () => {
        const account = await connect(
          'messenger',
          '112233445568004',
          'EAAGmessengertoken000000010',
          {
            humanAgentEnabled: true,
          },
        );
        const customer = await converse({
          account,
          customerId: '5012',
          lastInboundAgoMs: 7 * 24 * HOUR - MINUTE,
        });
        expect((await reply(customer.ticketId, '<p>Following up.</p>')).status).toBe(201);

        // Meta counts from an earlier message than Helpdock filed: by its clock the seven days
        // ran out a minute ago, by Helpdock's they have a minute left.
        graph.lastCustomerMessage.set('5012', new Date(Date.now() - 7 * 24 * HOUR - MINUTE));
        const [ran] = await runNew();

        expect(ran?.outcome).toBe('failed');
        expect(await onlyDelivery(customer.ticketId)).toMatchObject({
          status: 'refused',
          errorCode: '10/2018278',
        });
        expect(graph.sent).toEqual([]);
      });
    });
  });

  describe('the assistant’s message', () => {
    it('is refused with no job when the window is closed, and the message stays in the thread', async () => {
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: '16505550117',
        waId: '16505550117',
        lastInboundAgoMs: 25 * HOUR,
      });

      const messageId = await assistantSays(customer.ticketId, 'whatsapp');

      const delivery = await onlyDelivery(customer.ticketId);
      expect(delivery).toMatchObject({
        ticketMessageId: messageId,
        status: 'refused',
        errorCode: '131047',
      });
      expect(await outboxRowsFor(delivery.id)).toEqual([]);
      expect(await runNew()).toEqual([]);
      expect(graph.sent).toEqual([]);
      const listed = await call<MetaDeliveryList>(
        'GET',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries`,
        ada,
      );
      expect(listed.body.items).toMatchObject([{ status: 'refused', errorCode: '131047' }]);

      // Retry is refused with where the window stands: the customer has to write first.
      const retried = await call<unknown>(
        'POST',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries/${delivery.id}/retry`,
        ada,
      );
      expect(retried.status).toBe(409);
      expect(refusalOf(retried)).toMatchObject({
        reason: 'reply-window-closed',
        details: {
          platform: 'whatsapp',
          anchorAt: expect.any(String),
          closedAt: expect.any(String),
        },
      });
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({ status: 'refused' });
    });

    it('is queued like any reply while the window is open', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5008',
        lastInboundAgoMs: HOUR,
      });

      await assistantSays(customer.ticketId, 'messenger');

      const delivery = await onlyDelivery(customer.ticketId);
      expect(delivery.status).toBe('queued');
      expect(await outboxRowsFor(delivery.id)).toHaveLength(1);

      // Nobody wrote it, so the opening line is the brand alone: no first name.
      const [ran] = await runNew();

      expect(ran?.outcome).toBe('done');
      expect(
        sentOn('messenger', '5008').map(
          (message) => (message.payload as { message: { text: string } }).message.text,
        ),
      ).toEqual(['Helpdock Dev\nCan I help?']);
    });
  });

  // ------------------------------------------------------------------- Graph's refusals

  describe('what Graph refuses', () => {
    it('fails a send to a customer who blocked the account at once (551), and Retry puts it back', async () => {
      const waId = '16505550118';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: waId,
        waId,
        lastInboundAgoMs: HOUR,
      });
      graph.blocked.add(waId);
      await reply(customer.ticketId, '<p>Hello.</p>');

      const [ran] = await runNew();

      expect(ran?.outcome).toBe('failed');
      // The first attempt, not the fifth.
      const failed = await onlyDelivery(customer.ticketId);
      expect(failed).toMatchObject({
        status: 'failed',
        attempts: 1,
        errorCode: expect.stringMatching(/^551/),
      });
      expect(failed.lastError).toContain('551');
      expect(failed.failedAt).not.toBeNull();
      // The connection is not what failed, but Graph's last words are on the account.
      const account = await accountRow(customer.accountId);
      expect(account.status).toBe('connected');
      expect(account.lastError).toContain('551');

      graph.blocked.delete(waId);
      const retried = await call<unknown>(
        'POST',
        `/api/brands/${seeded.brandId}/tickets/${customer.ticketId}/meta/deliveries/${failed.id}/retry`,
        ada,
      );
      expect(retried.status).toBe(204);
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'queued',
        attempts: 0,
        lastError: null,
        errorCode: null,
      });
      const [resent] = await runNew();

      expect(resent?.outcome).toBe('done');
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({ status: 'sent' });
      expect(sentOn('whatsapp', waId)).toHaveLength(1);
    });

    it('fails a send with a dead token at once (190) and marks the account token_expired', async () => {
      const page = await connect('messenger', '112233445567001', 'EAAGmessengertoken000000006');
      const customer = await converse({
        account: page,
        customerId: '5009',
        lastInboundAgoMs: HOUR,
      });
      graph.expiredTokens.add('EAAGmessengertoken000000006');
      await reply(customer.ticketId, '<p>Hello.</p>');

      const [ran] = await runNew();

      expect(ran?.outcome).toBe('failed');
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'failed',
        attempts: 1,
        errorCode: '190/463',
      });
      const account = await accountRow(page.id);
      expect(account.status).toBe('token_expired');
      expect(account.lastError).toContain('190');
      expect(account.lastErrorAt).not.toBeNull();
      // Nothing about the token reaches the row.
      expect(account.lastError).not.toContain('EAAGmessengertoken000000006');
    });

    it('retries a rate limit (131056) after holding the pair’s slot, and sends on the next attempt', async () => {
      const waId = '16505550119';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: waId,
        waId,
        lastInboundAgoMs: HOUR,
      });
      graph.pairLimited.add(waId);
      await reply(customer.ticketId, '<p>Hello.</p>');

      const [first] = await runNew();

      expect(first?.outcome).toBe('failed');
      expect(first?.error).toMatchObject({ kind: 'rate_limited', code: 131_056 });
      // Still queued: the fifth attempt is not spent, and the next one waits out the pair.
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'queued',
        attempts: 1,
        errorCode: '131056',
      });
      const key = paceKey(customer.accountId, waId);
      expect(await redis.pttl(key)).toBeGreaterThan(5_000);
      expect((await accountRow(customer.accountId)).status).toBe('connected');

      graph.pairLimited.delete(waId);
      await redis.del(key);
      const second = first === undefined ? undefined : await again(first, { attemptsMade: 1 });

      expect(second?.outcome).toBe('done');
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'sent',
        lastError: null,
      });
    });

    it('ends in failed on the fifth attempt of a fault that does not clear', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5010',
        lastInboundAgoMs: HOUR,
      });
      await reply(customer.ticketId, '<p>Hello.</p>');
      graph.failures.push({ status: 500, match: /^POST \/\d+\/messages$/ });

      const [ran] = await runNew({ attemptsMade: 4 });

      expect(ran?.outcome).toBe('failed');
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'failed',
        attempts: 5,
      });
    });
  });

  // ---------------------------------------------------------------------- pacing

  describe('one WhatsApp user at a time', () => {
    it('keeps two replies to one customer six seconds apart, through a real worker, spending no attempt', async () => {
      const waId = '16505550120';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: waId,
        waId,
        lastInboundAgoMs: HOUR,
      });
      await reply(customer.ticketId, '<p>First.</p>');
      await reply(customer.ticketId, '<p>Second.</p>');

      const queue = new Queue(QUEUE_NAMES.outbound, { connection: redis });
      const processor = processorAt(null);
      const worker = new Worker(QUEUE_NAMES.outbound, (job, token) => processor(job, token), {
        connection: createQueueConnection(redisContainer.getConnectionUrl()),
        concurrency: 2,
      });
      try {
        const mine = await drain.drain<MetaSendPayload>(
          META_EVENTS.reply,
          createMetaReplyEventHandler,
        );
        expect(mine).toHaveLength(2);
        const ids: string[] = [];
        for (const { jobId, payload } of mine.flatMap((row) => row.jobs)) {
          ids.push(jobId);
          await queue.add(metaSendJob.name, payload, { ...metaSendJob.options, jobId });
        }

        await vi.waitFor(
          async () => {
            const rowsNow = await deliveriesOf(customer.ticketId);
            expect(rowsNow.map((row) => row.status)).toEqual(['sent', 'sent']);
          },
          { timeout: 40_000, interval: 250 },
        );

        // Two messages, the second sent a whole pace after the first ended.
        const [first, second] = [...client.timings].sort((a, b) => a.start - b.start);
        expect(client.timings).toHaveLength(2);
        expect((second?.start ?? 0) - (first?.end ?? 0)).toBeGreaterThanOrEqual(6_000);
        expect(sentOn('whatsapp', waId)).toHaveLength(2);
        // The wait was a delay, not a failure: no attempt was spent and nothing was recorded.
        for (const row of await deliveriesOf(customer.ticketId)) {
          expect(row.attempts).toBe(0);
          expect(row.lastError).toBeNull();
        }
        const jobs = await Promise.all(ids.map((id) => queue.getJob(id)));
        // The first job ran once. The second was moved to delayed at least once, and more than
        // once when the first send outlasted the 50 ms slack the wait is rounded up by: the slot
        // is set again for a pace from the end of that send.
        const started = jobs.map((job) => job?.attemptsStarted ?? 0).sort();
        expect(started[0]).toBe(1);
        expect(started[1]).toBeGreaterThanOrEqual(2);
        expect(jobs.every((job) => (job?.attemptsMade ?? 9) <= 1)).toBe(true);
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    }, 90_000);

    it('asks for the wait when the slot is held, and sends nothing before it is free', async () => {
      const waId = '16505550121';
      const customer = await converse({
        account: accounts.get(NUMBER) as MetaAccount,
        customerId: waId,
        waId,
        lastInboundAgoMs: HOUR,
      });
      await redis.set(paceKey(customer.accountId, waId), '1', 'PX', 4_000);
      await reply(customer.ticketId, '<p>Hello.</p>');

      const [ran] = await runNew({ autoPace: false });

      // Neither done nor failed: delayed, a little past what is left of the pace.
      expect(ran?.delays).toHaveLength(1);
      const wait = (ran?.delays[0] ?? 0) - Date.now();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(4_100);
      expect(graph.sent).toEqual([]);
      expect(await onlyDelivery(customer.ticketId)).toMatchObject({
        status: 'queued',
        partsSent: 0,
        attempts: 0,
        lastError: null,
      });
    });

    it('does not pace Messenger or Instagram', async () => {
      const customer = await converse({
        account: accounts.get(PAGE) as MetaAccount,
        customerId: '5011',
        lastInboundAgoMs: HOUR,
      });
      await reply(customer.ticketId, '<p>One.</p>');
      await reply(customer.ticketId, '<p>Two.</p>');

      const ran = await runNew({ autoPace: false });

      expect(ran.map((job) => [job.outcome, job.delays.length])).toEqual([
        ['done', 0],
        ['done', 0],
      ]);
      expect(sentOn('messenger', '5011')).toHaveLength(2);
    });
  });

  describe('finding a delivery by one of Meta’s ids', () => {
    it('is served by the GIN index on platform_message_ids, not by a scan of the brand’s deliveries', async () => {
      const plan = await owner.db.transaction(async (tx) => {
        // The table is a handful of rows here, so the planner would scan it whatever the index is for.
        await tx.execute(sql`set local enable_seqscan = off`);
        return tx.execute(
          sql`explain select id from meta_deliveries where platform_message_ids @> array['wamid.x']::text[]`,
        );
      });

      expect(JSON.stringify(plan)).toContain('meta_deliveries_platform_ids_idx');
    });
  });
});
