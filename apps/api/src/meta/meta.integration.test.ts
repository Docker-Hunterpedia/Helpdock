import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { GraphApiFailure, GraphClient } from '@helpdock/channels';
import {
  FakeGraph,
  fixtureWamid,
  META_FIXTURE,
  type MetaWebhookBody,
  MetaWebhookDriver,
  sha256Base64,
  whatsappAudioVoice,
  whatsappContacts,
  whatsappDocument,
  whatsappImage,
  whatsappLocation,
  whatsappNoWaId,
  whatsappReaction,
  whatsappStatus,
  whatsappText,
  whatsappUnsupported,
  whatsappUserChangedNumber,
} from '@helpdock/channels/testing';
import { createKeyring, type Env, encryptSecret } from '@helpdock/config';
import {
  attachments,
  blockedSenders,
  brands,
  contactDuplicateSuggestions,
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
  ticketActivity,
  ticketMessages,
  ticketStatuses,
  tickets,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { type MetaMediaFetchPayload, silentLogger } from '@helpdock/jobs';
import type { Principal } from '@helpdock/schemas';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import type { Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_PRINCIPAL_ENV_KEY, DEV_PRINCIPAL_HEADER } from '../auth/principal-resolver.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { createMediaTools, type MediaTools } from '../media/ffmpeg.js';
import { FakeStorage } from '../testing/media.js';
import { hasDocker, metaEnv, startPostgres, startRedis } from '../testing/meta-install.js';
import { createOutboxDrain, type OutboxDrain } from '../testing/meta-outbox.js';
import { createMetaInboundJobs } from './factory.js';
import { META_EVENTS } from './meta-events.js';

/**
 * The Meta channels against real Postgres and Redis, with the stand-in for
 * Graph (`FakeGraph`) and the signed-webhook driver of M10-01 (`MetaWebhookDriver`).
 * The worker is played by hand, one outbox row at a time, as the Telegram suite
 * plays it: the relay and BullMQ are covered elsewhere.
 *
 * **WhatsApp (M10-03)**: each event of DOMAIN-RULES §4.8 posted as Meta would
 * post it, signed, and followed to the rows it leaves. A message becomes a
 * ticket (or a reply on the conversation's) with the contact on the
 * business-scoped user id and the `wa_id` a verified phone; a file is
 * `pending` until `meta.media_fetch` has its bytes and `media.process` has made
 * them a WebP or an Opus voice note; a report moves a delivery forward and never
 * back; a blocked sender is dropped before any contact exists.
 */

const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');

const APP_SECRET = 'whatsapp-integration-app-secret';
const TOKEN = 'EAAGwhatsappintegrationtoken0123456789';
const BRAND_A = uuidv7();
const BRAND_B = uuidv7();
const AGENT_A = uuidv7();
const NUMBER_A = '106540352242922';
const NUMBER_B = '106540352242999';
const WABA_B = '202290129340399';

/** A person on brand A's desk, who reaches the routes the dev principal header stands in for. */
const agentA: Principal = {
  type: 'staff',
  id: AGENT_A,
  brands: { [BRAND_A]: { role: 'agent', departmentIds: 'all' } },
  installAdmin: false,
};

const run = promisify(execFile);

const hasFfmpeg = await Promise.all(
  ['ffmpeg', 'ffprobe'].map((binary) =>
    run(binary, ['-version'], { timeout: 10_000 }).then(
      () => true,
      () => false,
    ),
  ),
).then((found) => found.every(Boolean));

if (!hasDocker) {
  process.stderr.write(
    'Skipping the Meta integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const JPEG = await sharp({
  create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 200 } },
})
  .jpeg()
  .toBuffer();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** One person on WhatsApp: their number, their business-scoped user id and their name. */
interface Customer {
  readonly from: string;
  readonly userId: string;
  readonly profileName: string;
}

describe.skipIf(!hasDocker)('Meta channels', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let storage: FakeStorage;
  let driver: MetaWebhookDriver;
  let accountA: MetaAccount;
  let departmentA = '';
  let closedStatusId = '';
  let toOpusCalls = 0;
  const graph = new FakeGraph();
  let drain: OutboxDrain;
  let customers = 0;
  let wamids = 100;
  let clock = 0;

  const keyring = createKeyring({ APP_MASTER_KEY: MASTER_KEY });
  const envFor = (): Env =>
    metaEnv({ masterKey: MASTER_KEY, postgres, redis: redisContainer, graph });

  const graphClient = () =>
    new GraphClient({
      root: graph.facebookRoot,
      instagramRoot: graph.instagramRoot,
      allowCidrs: ['127.0.0.0/8'],
    });

  // ---------------------------------------------------------------- bodies

  const newCustomer = (overrides: Partial<Customer> = {}): Customer => {
    customers += 1;
    return {
      from: `1650555${String(2000 + customers)}`,
      userId: `US.${String(customers).padStart(20, '7')}`,
      profileName: `Customer ${String(customers)}`,
      ...overrides,
    };
  };
  const nextWamid = (): string => {
    wamids += 1;
    return fixtureWamid(wamids);
  };
  /** Every body is a second later than the last, as Meta's are: the window's anchor follows the clock. */
  const nextTimestamp = (): number => {
    clock += 1;
    return META_FIXTURE.time + clock;
  };
  const base = (customer: Customer, wamid = nextWamid()) => ({
    wabaId: META_FIXTURE.wabaId,
    phoneNumberId: NUMBER_A,
    from: customer.from,
    userId: customer.userId,
    profileName: customer.profileName,
    wamid,
    timestamp: nextTimestamp(),
  });

  const send = async (body: MetaWebhookBody): Promise<void> => {
    const response = await driver.post(body);
    expect(response.status).toBe(200);
  };
  const say = async (customer: Customer, text: string, wamid = nextWamid()): Promise<string> => {
    await send(whatsappText({ ...base(customer, wamid), text }));
    return wamid;
  };

  // ------------------------------------------------------------------ rows

  const contactOf = async (customer: Customer, brandId = BRAND_A) => {
    const [row] = await owner.db
      .select({ contact: contacts })
      .from(contactIdentities)
      .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
      .where(
        and(
          eq(contactIdentities.brandId, brandId),
          eq(contactIdentities.kind, 'whatsapp'),
          eq(contactIdentities.value, customer.userId),
        ),
      );
    return row?.contact;
  };
  const identitiesOf = (contactId: string) =>
    owner.db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, contactId))
      .orderBy(contactIdentities.kind);
  const conversationOf = async (customer: Customer) => {
    const [row] = await owner.db
      .select()
      .from(metaConversations)
      .where(eq(metaConversations.customerId, customer.userId));
    return row;
  };
  const ticketsOf = async (customer: Customer, brandId = BRAND_A) => {
    const contact = await contactOf(customer, brandId);
    return contact === undefined
      ? []
      : owner.db
          .select()
          .from(tickets)
          .where(eq(tickets.contactId, contact.id))
          .orderBy(tickets.number);
  };
  const messagesOf = (ticketId: string) =>
    owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticketId))
      .orderBy(ticketMessages.seq);
  const attachmentsOf = (ticketId: string) =>
    owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, ticketId))
      .orderBy(attachments.createdAt);
  const activityOf = (ticketId: string) =>
    owner.db.select().from(ticketActivity).where(eq(ticketActivity.ticketId, ticketId));
  const systemLines = async (ticketId: string): Promise<string[]> =>
    (await messagesOf(ticketId)).filter((row) => row.kind === 'system').map((row) => row.bodyText);
  const mediaEvents = (ticketId: string) =>
    attachmentsOf(ticketId).then(async (rows) => {
      const events = await owner.db
        .select()
        .from(outbox)
        .where(eq(outbox.event, META_EVENTS.media));
      const ids = new Set(rows.map((row) => row.id));
      return events.filter((event) => ids.has(String(event.payload.attachmentId)));
    });

  /** Opens a customer's conversation and returns its ticket. */
  const openTicket = async (customer: Customer, text = 'Is anyone there?') => {
    const wamid = await say(customer, text);
    const [ticket] = await ticketsOf(customer);
    if (ticket === undefined) {
      throw new Error('the message filed no ticket');
    }
    return { ticket, wamid };
  };

  const closeTicket = (ticketId: string, closedAt: Date) =>
    owner.db
      .update(tickets)
      .set({ statusId: closedStatusId, closedAt })
      .where(eq(tickets.id, ticketId));

  /** A reply an agent wrote, as the send job leaves it once Meta has accepted its parts. */
  const seedReply = async (
    customer: Customer,
    ticketId: string,
    wamidsSent: readonly string[],
    status: 'queued' | 'sent' = 'sent',
  ) => {
    const conversation = await conversationOf(customer);
    const [{ next } = { next: 1 }] = await owner.db
      .select({ next: sql<number>`coalesce(max(${ticketMessages.seq}), 0) + 1` })
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, ticketId));
    const [message] = await owner.db
      .insert(ticketMessages)
      .values({
        brandId: BRAND_A,
        ticketId,
        departmentId: departmentA,
        seq: next,
        kind: 'public',
        authorType: 'staff',
        authorId: uuidv7(),
        bodyHtml: '<p>It does, in blue.</p>',
        bodyText: 'It does, in blue.',
        channel: 'whatsapp',
      })
      .returning();
    const [delivery] = await owner.db
      .insert(metaDeliveries)
      .values({
        brandId: BRAND_A,
        departmentId: departmentA,
        ticketId,
        ticketMessageId: message?.id ?? '',
        accountId: accountA.id,
        conversationId: conversation?.id ?? '',
        customerId: customer.userId,
        status,
        platformMessageIds: [...wamidsSent],
        partsSent: wamidsSent.length,
        sentAt: new Date('2026-10-11T07:59:00Z'),
      })
      .returning();
    if (delivery === undefined) {
      throw new Error('the delivery was not seeded');
    }
    return delivery;
  };
  const deliveryOf = async (id: string) => {
    const [row] = await owner.db.select().from(metaDeliveries).where(eq(metaDeliveries.id, id));
    if (row === undefined) {
      throw new Error('the delivery is gone');
    }
    return row;
  };

  // ------------------------------------------------------------ the worker

  const inbound = () =>
    createMetaInboundJobs({
      db: runtime.db,
      storage,
      log: silentLogger,
      keyring,
      graph: graphClient(),
    });
  const tools = (): MediaTools => {
    const real = createMediaTools({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
    return {
      ...real,
      toOpus: async (options) => {
        toOpusCalls += 1;
        await real.toOpus(options);
      },
    };
  };

  interface FetchJob {
    readonly jobId: string;
    readonly payload: MetaMediaFetchPayload;
  }
  const fetchJob = (job: FetchJob, attempt: number): Job =>
    ({
      name: 'meta.media_fetch',
      id: job.jobId,
      data: job.payload,
      attemptsMade: attempt,
      opts: { attempts: 5 },
    }) as unknown as Job;

  /** The `meta.media_fetch` jobs `meta.media` outbox rows of these attachments ask for. */
  const fetchJobsFor = (ids: ReadonlySet<string>): Promise<FetchJob[]> => drain.fetchJobsFor(ids);

  /** Runs one fetch job and answers what it threw, which BullMQ would retry. */
  const runFetch = (job: FetchJob, attempt = 0): Promise<unknown> =>
    inbound()
      .mediaFetch(fetchJob(job, attempt))
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  /** Every file of a ticket fetched and processed, as the worker does after the relay. */
  const pipeline = async (ticketId: string): Promise<unknown[]> =>
    drain.mediaPipeline(
      new Set((await attachmentsOf(ticketId)).map((row) => row.id)),
      (job) => runFetch(job),
      { storage, tools },
    );

  // ----------------------------------------------------------------- setup

  const seedBrand = async (
    id: string,
    prefix: string,
    number: string,
    wabaId: string,
    locale: 'en' | 'ar' = 'en',
  ): Promise<MetaAccount> => {
    await runtime.db.insert(brands).values({ id, name: prefix, prefix, defaultLocale: locale });
    return withSystem(runtime.db, id, async (tx) => {
      await seedBrandStatuses(tx, id);
      const [department] = await tx
        .insert(departments)
        .values({ brandId: id, name: 'Support' })
        .returning({ id: departments.id });
      const [account] = await tx
        .insert(metaAccounts)
        .values({
          brandId: id,
          platform: 'whatsapp',
          departmentId: department?.id ?? '',
          externalId: number,
          wabaId,
          displayPhone: '+15550783881',
          displayName: `${prefix} WhatsApp`,
          accessToken: encryptSecret(TOKEN, keyring),
          tokenKind: 'system_user',
          tokenUpdatedAt: new Date(),
        })
        .returning();
      if (account === undefined) {
        throw new Error('the account was not seeded');
      }
      return account;
    });
  };

  beforeAll(async () => {
    process.env[DEV_PRINCIPAL_ENV_KEY] = '1';
    [postgres, redisContainer] = await Promise.all([startPostgres(), startRedis(), graph.start()]);
    graph.connect({
      platform: 'whatsapp',
      id: NUMBER_A,
      wabaId: META_FIXTURE.wabaId,
      name: 'ACME WhatsApp',
      displayPhone: '+15550783881',
      token: TOKEN,
    });
    graph.connect({
      platform: 'whatsapp',
      id: NUMBER_B,
      wabaId: WABA_B,
      name: 'GLOBEX WhatsApp',
      displayPhone: '+15550783882',
      token: TOKEN,
    });

    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({
        env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
        level: 'silent',
      }),
    });
    storage = new FakeStorage(await mkdtemp(path.join(tmpdir(), 'helpdock-meta-')));
    app = await createApiApp({ runtime, objectStorage: storage, meta: { graph: graphClient() } });
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    drain = createOutboxDrain({ db: runtime.db, owner: owner.db });
    driver = new MetaWebhookDriver({ target: app, secret: APP_SECRET });
    await owner.db
      .insert(users)
      .values({ id: AGENT_A, email: 'agent@example.com', name: 'Sara Hassan' });

    accountA = await seedBrand(BRAND_A, 'ACME', NUMBER_A, META_FIXTURE.wabaId);
    departmentA = accountA.departmentId;
    await seedBrand(BRAND_B, 'GLOBEX', NUMBER_B, WABA_B, 'ar');
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
    closedStatusId = closed?.id ?? '';
    await runtime.settings.set('meta.appSecret', APP_SECRET, { updatedBy: 'suite' });
  }, 300_000);

  afterAll(async () => {
    delete process.env[DEV_PRINCIPAL_ENV_KEY];
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await graph.stop();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  // A failure inside the stand-in reads to Helpdock as Meta being down, and a retry test would
  // pass on it: it is said here, in the test it happened in.
  afterEach(() => {
    expect(graph.errors).toEqual([]);
  });

  // What a test programs the stand-in with, and the calls it made, are that test's alone.
  beforeEach(() => {
    graph.reset();
  });

  // =========================================================================

  describe('WhatsApp (M10-03)', () => {
    // ------------------------------------------------------------- messages

    describe('a text message', () => {
      it('opens a ticket with the contact on the user id and the phone verified', async () => {
        const customer = newCustomer();
        const wamid = await say(customer, 'Does it come in another color?');

        const contact = await contactOf(customer);
        expect(contact).toMatchObject({ name: customer.profileName });
        expect(await identitiesOf(contact?.id ?? '')).toEqual([
          expect.objectContaining({
            kind: 'phone',
            value: `+${customer.from}`,
            verified: true,
            source: 'whatsapp.cloud',
          }),
          expect.objectContaining({
            kind: 'whatsapp',
            value: customer.userId,
            verified: true,
            source: 'whatsapp.cloud',
          }),
        ]);

        const [ticket] = await ticketsOf(customer);
        expect(ticket).toMatchObject({
          channel: 'whatsapp',
          departmentId: departmentA,
          subject: 'Does it come in another color?',
        });
        expect(await messagesOf(ticket?.id ?? '')).toMatchObject([
          {
            kind: 'public',
            authorType: 'contact',
            channel: 'whatsapp',
            externalMessageId: wamid,
            bodyText: 'Does it come in another color?',
          },
        ]);
        expect(await conversationOf(customer)).toMatchObject({
          accountId: accountA.id,
          contactId: contact?.id,
          ticketId: ticket?.id,
          waId: customer.from,
          profileName: customer.profileName,
          lastInboundMessageId: wamid,
          lastInboundAt: new Date((META_FIXTURE.time + clock) * 1_000),
        });
        expect(await activityOf(ticket?.id ?? '')).toMatchObject([
          { action: 'ticket.created', actorType: 'system', actorId: `meta:${accountA.id}` },
        ]);
        // Filing the message called nobody: Meta waits for the webhook, not the other way round.
        expect(graph.calls).toEqual([]);
      });

      it('continues the same ticket with the next message, and files a redelivery once', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer, 'Hello?');
        const second = nextWamid();

        await say(customer, 'Anybody there?', second);
        await say(customer, 'Anybody there?', second);

        expect(await ticketsOf(customer)).toHaveLength(1);
        expect((await messagesOf(ticket.id)).map((row) => row.bodyText)).toEqual([
          'Hello?',
          'Anybody there?',
        ]);
        expect((await activityOf(ticket.id)).map((row) => row.action).sort()).toEqual([
          'ticket.created',
          'ticket.replied',
        ]);
        expect(await conversationOf(customer)).toMatchObject({ lastInboundMessageId: second });
        expect(await identitiesOf((await contactOf(customer))?.id ?? '')).toHaveLength(2);
      });

      it('files a new customer’s first message once when Meta posts it twice at the same moment', async () => {
        const customer = newCustomer();
        const wamid = nextWamid();
        const body = whatsappText({ ...base(customer, wamid), text: 'First, and doubled' });

        // Contact, conversation and ticket are all new: the two posts race to create each, and
        // the message's unique index is what decides between them.
        const [one, other] = await Promise.all([driver.post(body), driver.post(body)]);

        expect([one.status, other.status]).toEqual([200, 200]);
        const identities = await owner.db
          .select()
          .from(contactIdentities)
          .where(
            and(
              eq(contactIdentities.brandId, BRAND_A),
              eq(contactIdentities.kind, 'whatsapp'),
              eq(contactIdentities.value, customer.userId),
            ),
          );
        expect(identities).toHaveLength(1);
        expect(
          await owner.db
            .select()
            .from(metaConversations)
            .where(eq(metaConversations.customerId, customer.userId)),
        ).toHaveLength(1);
        const [ticket, ...rest] = await ticketsOf(customer);
        expect(rest).toEqual([]);
        expect((await messagesOf(ticket?.id ?? '')).map((row) => row.externalMessageId)).toEqual([
          wamid,
        ]);
      });

      it('reopens a closed ticket inside the reopen window', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        await closeTicket(ticket.id, new Date(Date.now() - 86_400_000));

        await say(customer, 'It still has not come');

        const after = await ticketsOf(customer);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id: ticket.id, closedAt: null });
      });

      it('continues in a new ticket once the reopen window has passed', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        await closeTicket(ticket.id, new Date(Date.now() - 10 * 86_400_000));

        await say(customer, 'Hello again, after a while');

        const after = await ticketsOf(customer);
        expect(after).toHaveLength(2);
        const [old, next] = after;
        expect(old).toMatchObject({ id: ticket.id, statusId: closedStatusId });
        expect(next).toMatchObject({ channel: 'whatsapp', departmentId: departmentA });
        expect((await messagesOf(next?.id ?? '')).map((row) => row.bodyText)).toContain(
          'Hello again, after a while',
        );
        expect(await conversationOf(customer)).toMatchObject({ ticketId: next?.id });
        const continued = await owner.db
          .select()
          .from(ticketActivity)
          .where(
            and(
              eq(ticketActivity.action, 'ticket.continued'),
              inArray(ticketActivity.ticketId, [ticket.id, next?.id ?? '']),
            ),
          );
        expect(continued).toHaveLength(2);
      });

      it('quotes the message it answers when that is on the ticket, and only then', async () => {
        const customer = newCustomer();
        const { ticket, wamid } = await openTicket(customer, 'Is it waterproof?');

        await send(whatsappText({ ...base(customer), text: 'And the strap?', quotes: wamid }));
        await send(
          whatsappText({ ...base(customer), text: 'Forget it', quotes: fixtureWamid(99_999) }),
        );

        const [, quoting, unknown] = await messagesOf(ticket.id);
        expect(quoting?.bodyHtml).toContain('<blockquote><p>Is it waterproof?</p></blockquote>');
        expect(quoting?.bodyText).toContain('Is it waterproof?');
        expect(quoting?.bodyText).toContain('And the strap?');
        expect(unknown?.bodyHtml).not.toContain('blockquote');
        expect(unknown?.bodyText).toBe('Forget it');
      });

      it('quotes one of the agent’s replies by the ids Meta gave its parts', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer, 'Do you have it in blue?');
        const replyId = nextWamid();
        await seedReply(customer, ticket.id, [replyId]);

        await send(whatsappText({ ...base(customer), text: 'Great, send one', quotes: replyId }));

        const last = (await messagesOf(ticket.id)).at(-1);
        expect(last?.bodyHtml).toContain('<blockquote><p>It does, in blue.</p></blockquote>');
      });

      it('words a location, and shared contacts, in the contact’s language', async () => {
        const customer = newCustomer();
        await send(whatsappLocation({ ...base(customer) }));
        await send(whatsappContacts({ ...base(customer) }));

        const [ticket] = await ticketsOf(customer);
        const [location, shared] = await messagesOf(ticket?.id ?? '');
        expect(location?.bodyText).toContain('Location: 52.52, 13.405');
        expect(location?.bodyText).toContain('Brandenburg Gate');
        expect(location?.bodyHtml).toContain('href="https://www.openstreetmap.org/');
        expect(shared?.bodyText).toContain('Contact: Mona Khalil');
        expect(shared?.bodyText).toContain('+963 931 234 567');
        expect(shared?.bodyText).toContain('mona@example.com');
      });
    });

    describe('identity', () => {
      it('keys a customer with no number on the user id alone', async () => {
        const customer = newCustomer({ profileName: 'Sheena Nelson' });
        await send(
          whatsappNoWaId({
            wabaId: META_FIXTURE.wabaId,
            phoneNumberId: NUMBER_A,
            userId: customer.userId,
            profileName: customer.profileName,
            wamid: nextWamid(),
            text: 'Hello from a username',
          }),
        );

        const contact = await contactOf(customer);
        expect(contact).toMatchObject({ name: 'Sheena Nelson' });
        expect(await identitiesOf(contact?.id ?? '')).toMatchObject([
          { kind: 'whatsapp', value: customer.userId, verified: true },
        ]);
        expect(await conversationOf(customer)).toMatchObject({
          waId: null,
          username: 'sheena.nelson',
        });
        const [ticket] = await ticketsOf(customer);
        expect(ticket).toMatchObject({ channel: 'whatsapp', subject: 'Hello from a username' });
      });

      it('moves a phone an agent typed earlier to the contact that proved it, and suggests the pair', async () => {
        const customer = newCustomer();
        const typed = uuidv7();
        await owner.db
          .insert(contacts)
          .values({ id: typed, brandId: BRAND_A, name: 'Typed by Ada' });
        await owner.db.insert(contactIdentities).values({
          brandId: BRAND_A,
          contactId: typed,
          kind: 'phone',
          value: `+${customer.from}`,
          verified: false,
          source: 'agent',
        });

        await say(customer, 'Hi, it is me');

        const proven = await contactOf(customer);
        expect(proven?.id).not.toBe(typed);
        expect(await identitiesOf(typed)).toEqual([]);
        expect(await identitiesOf(proven?.id ?? '')).toContainEqual(
          expect.objectContaining({
            kind: 'phone',
            value: `+${customer.from}`,
            verified: true,
            source: 'whatsapp.cloud',
          }),
        );
        const suggestions = await owner.db
          .select()
          .from(contactDuplicateSuggestions)
          .where(inArray(contactDuplicateSuggestions.contactId, [typed, proven?.id ?? '']));
        expect(suggestions).toMatchObject([{ reason: 'phone' }]);
      });

      it('leaves a phone another contact has proved where it is, files the message, and suggests the pair', async () => {
        const first = newCustomer();
        const second = newCustomer({ from: first.from });
        await say(first, 'First');

        await say(second, 'Second, same number');

        const firstContact = await contactOf(first);
        const secondContact = await contactOf(second);
        expect(secondContact?.id).not.toBe(firstContact?.id);
        expect(await identitiesOf(firstContact?.id ?? '')).toContainEqual(
          expect.objectContaining({ kind: 'phone', value: `+${first.from}`, verified: true }),
        );
        expect(await identitiesOf(secondContact?.id ?? '')).not.toContainEqual(
          expect.objectContaining({ kind: 'phone' }),
        );
        expect(await ticketsOf(second)).toHaveLength(1);
        const suggestions = await owner.db
          .select()
          .from(contactDuplicateSuggestions)
          .where(
            inArray(contactDuplicateSuggestions.contactId, [
              firstContact?.id ?? '',
              secondContact?.id ?? '',
            ]),
          );
        expect(suggestions).toMatchObject([{ reason: 'phone' }]);
      });

      it('re-links a customer whose number changed, and says so on the open ticket', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const newNumber = '16505559999';

        await send(
          whatsappUserChangedNumber({
            ...base(customer),
            oldWaId: customer.from,
            newWaId: newNumber,
          }),
        );

        const contact = await contactOf(customer);
        const phones = (await identitiesOf(contact?.id ?? '')).filter(
          (row) => row.kind === 'phone',
        );
        expect(phones).toMatchObject([
          { value: `+${newNumber}`, verified: true, source: 'whatsapp.cloud' },
        ]);
        expect(await conversationOf(customer)).toMatchObject({ waId: newNumber });
        expect(await systemLines(ticket.id)).toEqual([
          `The customer's WhatsApp number changed from +${customer.from} to +${newNumber}.`,
        ]);
        // A change of number is not a message: no window, no second ticket.
        expect(await ticketsOf(customer)).toHaveLength(1);
      });

      it('ignores a change of number for a customer it has never heard from', async () => {
        const stranger = newCustomer();

        await send(whatsappUserChangedNumber({ ...base(stranger), newWaId: '16505558888' }));

        expect(await contactOf(stranger)).toBeUndefined();
        expect(await conversationOf(stranger)).toBeUndefined();
      });
    });

    // ---------------------------------------------------------------- media

    describe('files', () => {
      it('files an image pending, fetches it by its media id, and makes it a WebP', async () => {
        const customer = newCustomer();
        const mediaId = `IMG-${customer.userId}`;
        graph.serveMedia(mediaId, JPEG, 'image/jpeg');

        await send(
          whatsappImage({
            ...base(customer),
            mediaId,
            sha256: sha256Base64(JPEG),
            caption: 'the box',
          }),
        );

        const [ticket] = await ticketsOf(customer);
        const [message] = await messagesOf(ticket?.id ?? '');
        expect(message).toMatchObject({ bodyText: 'the box' });
        expect(ticket?.subject).toBe('the box');
        const [pending] = await attachmentsOf(ticket?.id ?? '');
        expect(pending).toMatchObject({
          messageId: message?.id,
          status: 'pending',
          kind: 'image',
          mime: 'image/jpeg',
          size: 0,
          originalName: 'image.jpg',
          uploaderType: 'contact',
        });
        expect(await mediaEvents(ticket?.id ?? '')).toMatchObject([
          {
            payload: {
              attachmentId: pending?.id,
              accountId: accountA.id,
              ref: { kind: 'whatsapp_media', mediaId, mimeType: 'image/jpeg' },
            },
          },
        ]);
        // The webhook answered without fetching anything.
        expect(graph.callsTo(`/${mediaId}`)).toEqual([]);

        expect(await pipeline(ticket?.id ?? '')).toEqual([]);

        const [ready] = await attachmentsOf(ticket?.id ?? '');
        expect(ready).toMatchObject({ status: 'ready', kind: 'image', size: JPEG.length });
        expect(Object.keys(ready?.variants ?? {})).toContain('webp');
        const webp = await storage.read(
          `brands/${BRAND_A}/tickets/${ticket?.id}/${ready?.id}/webp`,
        );
        expect((await sharp(webp).metadata()).format).toBe('webp');
        expect(graph.callsTo(`/${mediaId}`, 'GET')).toMatchObject([{ token: TOKEN }]);
        expect(graph.mediaRequests).toContainEqual(
          expect.objectContaining({ kind: 'media', authorization: `Bearer ${TOKEN}` }),
        );
      });

      it('rejects a file whose bytes are not the ones Meta described, and keeps the message', async () => {
        const customer = newCustomer();
        const mediaId = `WRONG-${customer.userId}`;
        graph.serveMedia(mediaId, JPEG, 'image/jpeg');

        await send(
          whatsappImage({
            ...base(customer),
            mediaId,
            sha256: sha256Base64(Buffer.from('some other file')),
          }),
        );
        const [ticket] = await ticketsOf(customer);
        expect(await pipeline(ticket?.id ?? '')).toEqual([]);

        const [row] = await attachmentsOf(ticket?.id ?? '');
        expect(row).toMatchObject({ status: 'rejected', rejectReason: 'unreadable' });
        await expect(storage.read(row?.s3Key ?? '')).rejects.toThrow();
        expect(await messagesOf(ticket?.id ?? '')).toHaveLength(1);
      });

      it('rejects a file over the brand’s cap without downloading it', async () => {
        const customer = newCustomer();
        const mediaId = `BIG-${customer.userId}`;
        const big = Buffer.alloc(11 * 1_048_576, 1);
        graph.serveMedia(mediaId, big, 'image/jpeg');

        await send(whatsappImage({ ...base(customer), mediaId, sha256: sha256Base64(big) }));
        const [ticket] = await ticketsOf(customer);
        await pipeline(ticket?.id ?? '');

        const [row] = await attachmentsOf(ticket?.id ?? '');
        expect(row).toMatchObject({ status: 'rejected', rejectReason: 'too_large' });
        expect(graph.mediaRequests.filter((request) => request.name === mediaId)).toEqual([]);
      });

      it('files a document under the name WhatsApp gave it', async () => {
        const customer = newCustomer();
        const mediaId = `DOC-${customer.userId}`;
        graph.serveMedia(mediaId, PDF, 'application/pdf');

        await send(
          whatsappDocument({
            ...base(customer),
            mediaId,
            sha256: sha256Base64(PDF),
            filename: 'invoice-1042.pdf',
            caption: 'the invoice',
          }),
        );
        const [ticket] = await ticketsOf(customer);
        expect(await pipeline(ticket?.id ?? '')).toEqual([]);

        const [row] = await attachmentsOf(ticket?.id ?? '');
        expect(row).toMatchObject({
          status: 'ready',
          kind: 'file',
          mime: 'application/pdf',
          originalName: 'invoice-1042.pdf',
        });
      });

      it('fetches a 20 MB document by its media id, verifies it and processes it', async () => {
        const customer = newCustomer();
        const mediaId = `LARGE-${customer.userId}`;
        const large = Buffer.concat([PDF, Buffer.alloc(20 * 1_048_576 - PDF.length, 0x20)]);
        graph.serveMedia(mediaId, large, 'application/pdf');

        await send(
          whatsappDocument({
            ...base(customer),
            mediaId,
            sha256: sha256Base64(large),
            filename: 'catalogue.pdf',
          }),
        );
        const [ticket] = await ticketsOf(customer);
        expect(await pipeline(ticket?.id ?? '')).toEqual([]);

        const [row] = await attachmentsOf(ticket?.id ?? '');
        expect(row).toMatchObject({ status: 'ready', kind: 'file', size: large.length });
        expect((await storage.read(row?.s3Key ?? '')).length).toBe(large.length);
      });

      it.skipIf(!hasFfmpeg)('sends a voice note through ffmpeg to Opus in Ogg', async () => {
        const customer = newCustomer();
        const mediaId = `VOICE-${customer.userId}`;
        const dir = await mkdtemp(path.join(tmpdir(), 'helpdock-voice-'));
        const source = path.join(dir, 'voice.ogg');
        await run('ffmpeg', [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:a',
          'libopus',
          '-f',
          'ogg',
          '-y',
          source,
        ]);
        const voice = await readFile(source);
        graph.serveMedia(mediaId, voice, 'audio/ogg; codecs=opus');
        const before = toOpusCalls;

        await send(whatsappAudioVoice({ ...base(customer), mediaId, sha256: sha256Base64(voice) }));
        const [ticket] = await ticketsOf(customer);
        expect((await attachmentsOf(ticket?.id ?? ''))[0]).toMatchObject({
          kind: 'audio',
          mime: 'audio/ogg',
          originalName: 'voice-note.ogg',
        });
        expect(await pipeline(ticket?.id ?? '')).toEqual([]);

        const [row] = await attachmentsOf(ticket?.id ?? '');
        expect(row).toMatchObject({ status: 'ready', kind: 'audio' });
        expect(Object.keys(row?.variants ?? {})).toContain('opus');
        expect(toOpusCalls).toBe(before + 1);
      });

      it('asks again for a media id Meta says is gone, and rejects it on the last attempt', async () => {
        const customer = newCustomer();
        const mediaId = `GONE-${customer.userId}`;
        graph.serveMedia(mediaId, JPEG, 'image/jpeg');
        graph.expiredMedia.add(mediaId);
        await send(whatsappImage({ ...base(customer), mediaId, sha256: sha256Base64(JPEG) }));
        const [ticket] = await ticketsOf(customer);
        const ids = new Set((await attachmentsOf(ticket?.id ?? '')).map((row) => row.id));
        const [job] = await fetchJobsFor(ids);

        const first = await runFetch(job as FetchJob, 0);
        expect(first).toBeInstanceOf(GraphApiFailure);
        expect((await attachmentsOf(ticket?.id ?? ''))[0]?.status).toBe('pending');

        expect(await runFetch(job as FetchJob, 4)).toBeUndefined();
        expect((await attachmentsOf(ticket?.id ?? ''))[0]).toMatchObject({
          status: 'rejected',
          rejectReason: 'object_missing',
        });
      });

      it('marks the account when Meta no longer accepts its token, and asks again', async () => {
        const customer = newCustomer();
        const mediaId = `TOKEN-${customer.userId}`;
        graph.serveMedia(mediaId, JPEG, 'image/jpeg');
        await send(whatsappImage({ ...base(customer), mediaId, sha256: sha256Base64(JPEG) }));
        const [ticket] = await ticketsOf(customer);
        const ids = new Set((await attachmentsOf(ticket?.id ?? '')).map((row) => row.id));
        const [job] = await fetchJobsFor(ids);
        graph.expiredTokens.add(TOKEN);

        try {
          expect(await runFetch(job as FetchJob, 0)).toBeInstanceOf(GraphApiFailure);

          const [account] = await owner.db
            .select()
            .from(metaAccounts)
            .where(eq(metaAccounts.id, accountA.id));
          expect(account).toMatchObject({ status: 'token_expired' });
          expect(account?.lastError).toContain('190');
          expect(account?.lastError).not.toContain(TOKEN);
          expect((await attachmentsOf(ticket?.id ?? ''))[0]?.status).toBe('pending');
        } finally {
          graph.expiredTokens.delete(TOKEN);
          // The account is shared: put it back for the tests after this one, whatever was found.
          await owner.db
            .update(metaAccounts)
            .set({ status: 'connected', lastError: null, lastErrorAt: null })
            .where(eq(metaAccounts.id, accountA.id));
        }
      });

      it('records the files of a message Meta reported an error for as rejected, and fetches none', async () => {
        const customer = newCustomer();
        const body = whatsappImage({
          ...base(customer),
          mediaId: `ERR-${customer.userId}`,
          sha256: sha256Base64(JPEG),
        }) as { entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[] };
        const message = body.entry[0]?.changes[0]?.value.messages[0];
        if (message !== undefined) {
          message.errors = [{ code: 131_052, title: 'Media download error' }];
        }

        await send(body as unknown as MetaWebhookBody);

        const [ticket] = await ticketsOf(customer);
        expect(await attachmentsOf(ticket?.id ?? '')).toMatchObject([
          { status: 'rejected', rejectReason: 'unreadable' },
        ]);
        expect(await mediaEvents(ticket?.id ?? '')).toEqual([]);
      });
    });

    // ------------------------------------------------------------- statuses

    describe('delivery reports', () => {
      const report = (
        customer: Customer,
        wamid: string,
        status: 'sent' | 'delivered' | 'read' | 'failed',
        extra: { category?: 'service' | 'utility'; errorCode?: number; errorTitle?: string } = {},
      ) =>
        whatsappStatus({
          wabaId: META_FIXTURE.wabaId,
          phoneNumberId: NUMBER_A,
          from: customer.from,
          userId: customer.userId,
          wamid,
          status,
          ...extra,
        });

      it('leaves read when delivered arrives after it in the same batch', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const sent = nextWamid();
        const delivery = await seedReply(customer, ticket.id, [sent]);

        const response = await driver.postBatch([
          report(customer, sent, 'read'),
          report(customer, sent, 'delivered'),
        ]);
        expect(response.status).toBe(200);

        expect(await deliveryOf(delivery.id)).toMatchObject({
          status: 'read',
          deliveredAt: expect.any(Date),
          readAt: expect.any(Date),
        });
      });

      it('moves a delivery forward one report at a time, and never back', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const sent = nextWamid();
        const delivery = await seedReply(customer, ticket.id, [sent]);

        await send(report(customer, sent, 'sent'));
        expect((await deliveryOf(delivery.id)).status).toBe('sent');
        await send(report(customer, sent, 'delivered'));
        expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'delivered' });
        await send(report(customer, sent, 'read'));
        await send(report(customer, sent, 'delivered'));
        await send(report(customer, sent, 'sent'));

        expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'read' });
      });

      it('records what Meta billed a reply as', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const sent = nextWamid();
        const delivery = await seedReply(customer, ticket.id, [sent]);

        await send(report(customer, sent, 'delivered', { category: 'utility' }));

        expect(await deliveryOf(delivery.id)).toMatchObject({
          status: 'delivered',
          pricingCategory: 'utility',
        });
      });

      it('ends a reply Meta could not deliver as failed, with its code and its words', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const sent = nextWamid();
        const delivery = await seedReply(customer, ticket.id, [sent]);

        await send(
          report(customer, sent, 'failed', {
            errorCode: 131_026,
            errorTitle: 'Message undeliverable',
          }),
        );

        expect(await deliveryOf(delivery.id)).toMatchObject({
          status: 'failed',
          errorCode: '131026',
          lastError: '131026: Message undeliverable',
          failedAt: expect.any(Date),
        });
      });

      it('ends a reply refused because the window had closed as refused, which no retry fixes', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const sent = nextWamid();
        const delivery = await seedReply(customer, ticket.id, [sent]);

        await send(
          report(customer, sent, 'failed', {
            errorCode: 131_047,
            errorTitle: 'Re-engagement message',
          }),
        );

        expect(await deliveryOf(delivery.id)).toMatchObject({
          status: 'refused',
          errorCode: '131047',
        });
      });

      it('does not move a delivery that was already read to failed', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const sent = nextWamid();
        const delivery = await seedReply(customer, ticket.id, [sent]);
        await send(report(customer, sent, 'read'));

        await send(report(customer, sent, 'failed'));

        expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'read', errorCode: null });
      });

      it('answers 200 to a report on a message Helpdock did not send', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const delivery = await seedReply(customer, ticket.id, [nextWamid()]);

        await send(report(customer, nextWamid(), 'read'));

        expect(await deliveryOf(delivery.id)).toMatchObject({ status: 'sent', readAt: null });
      });
    });

    // ---------------------------------------------- unsupported and reactions

    describe('what Helpdock cannot show, and reactions', () => {
      it('notes an unsupported message on the open ticket once, and opens the window', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const wamid = nextWamid();
        const stamped = base(customer, wamid);

        await send(whatsappUnsupported(stamped));
        await send(whatsappUnsupported(stamped));

        expect(await systemLines(ticket.id)).toEqual([
          'The customer sent something that cannot be shown here.',
        ]);
        const after = await conversationOf(customer);
        // The customer wrote, so the window moves to the time Meta stamped the message with.
        expect(after).toMatchObject({ lastInboundMessageId: wamid });
        expect(after?.lastInboundAt?.getTime()).toBe(stamped.timestamp * 1_000);
        // Not a message: the thread still has the one the customer wrote.
        expect((await messagesOf(ticket.id)).filter((row) => row.kind === 'public')).toHaveLength(
          1,
        );
      });

      it('counts an unsupported message from a customer with no conversation and files nothing', async () => {
        const stranger = newCustomer();

        await send(whatsappUnsupported({ ...base(stranger) }));

        expect(await contactOf(stranger)).toBeUndefined();
        expect(await conversationOf(stranger)).toBeUndefined();
      });

      it('adds no line to a closed ticket', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        await closeTicket(ticket.id, new Date());

        await send(whatsappUnsupported({ ...base(customer) }));

        expect(await systemLines(ticket.id)).toEqual([]);
      });

      it('notes a reaction on the ticket of the message it is on, and its removal', async () => {
        const customer = newCustomer();
        const { ticket, wamid } = await openTicket(customer, 'Do you ship to Berlin?');
        const before = await conversationOf(customer);

        await send(whatsappReaction({ ...base(customer), reactsTo: wamid, emoji: '\u{1F44D}' }));
        await send(whatsappReaction({ ...base(customer), reactsTo: wamid, emoji: '' }));

        expect(await systemLines(ticket.id)).toEqual([
          'The customer reacted \u{1F44D} to a message.',
          'The customer removed their reaction to a message.',
        ]);
        // A reaction is never a message and never a window.
        expect(await conversationOf(customer)).toMatchObject({
          lastInboundMessageId: before?.lastInboundMessageId,
          lastInboundAt: before?.lastInboundAt,
        });
        expect((await messagesOf(ticket.id)).filter((row) => row.kind === 'public')).toHaveLength(
          1,
        );
      });

      it('notes a reaction once however often Meta delivers it', async () => {
        const customer = newCustomer();
        const { ticket, wamid } = await openTicket(customer);
        const body = whatsappReaction({ ...base(customer), reactsTo: wamid, emoji: '\u{1F44D}' });

        await send(body);
        await send(body);

        expect(await systemLines(ticket.id)).toEqual([
          'The customer reacted \u{1F44D} to a message.',
        ]);
        // The key names the message, the way and the time: no customer id outlives an erasure in it.
        const [line] = (await messagesOf(ticket.id)).filter((row) => row.kind === 'system');
        expect(line?.externalMessageId).toMatch(/^reaction:wamid\.[^:]+:react:\d+$/);
        expect(line?.externalMessageId).not.toContain(customer.userId);
      });

      it('tells a change of number once however often Meta delivers it', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const body = whatsappUserChangedNumber({
          ...base(customer),
          oldWaId: customer.from,
          newWaId: '16505559999',
        });

        await send(body);
        await send(body);

        expect(await systemLines(ticket.id)).toHaveLength(1);
      });

      it('files each line once on the primary of a merge, even when the primary is an email ticket', async () => {
        const [secondary, primary] = [newCustomer(), newCustomer()];
        const first = await openTicket(secondary, 'My order is late');
        const into = await openTicket(primary, 'Another question');
        // The line goes to the primary, whose channel decides the key's uniqueness.
        await owner.db
          .update(tickets)
          .set({ channel: 'email' })
          .where(eq(tickets.id, into.ticket.id));
        await owner.db
          .update(tickets)
          .set({ mergedIntoId: into.ticket.id })
          .where(eq(tickets.id, first.ticket.id));
        const unsupported = whatsappUnsupported({ ...base(secondary) });
        const reaction = whatsappReaction({
          ...base(secondary),
          reactsTo: first.wamid,
          emoji: '\u{1F44D}',
        });

        for (const body of [unsupported, unsupported, reaction, reaction]) {
          await send(body);
        }

        expect(await systemLines(first.ticket.id)).toEqual([]);
        expect(await systemLines(into.ticket.id)).toEqual([
          'The customer sent something that cannot be shown here.',
          'The customer reacted \u{1F44D} to a message.',
        ]);
      });

      it('notes a reaction to the agent’s reply on its ticket', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);
        const replyId = nextWamid();
        await seedReply(customer, ticket.id, [replyId]);

        await send(whatsappReaction({ ...base(customer), reactsTo: replyId, emoji: '❤' }));

        expect(await systemLines(ticket.id)).toEqual(['The customer reacted ❤ to a message.']);
      });

      it('drops a reaction to a message Helpdock never filed', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer);

        await send(whatsappReaction({ ...base(customer), reactsTo: fixtureWamid(88_888) }));

        expect(await systemLines(ticket.id)).toEqual([]);
      });

      it('escapes what a reaction carries into the thread’s HTML', async () => {
        const customer = newCustomer();
        const { ticket, wamid } = await openTicket(customer);

        await send(whatsappReaction({ ...base(customer), reactsTo: wamid, emoji: '<img src=x>' }));

        const line = (await messagesOf(ticket.id)).find((row) => row.kind === 'system');
        expect(line?.bodyHtml).not.toContain('<img');
        expect(line?.bodyHtml).toContain('&lt;img src=x&gt;');
      });
    });

    // -------------------------------------------------------------- errors

    describe('errors Meta reports', () => {
      it('notes an error about the account itself on the account, and files nothing', async () => {
        const body = {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: META_FIXTURE.wabaId,
              changes: [
                {
                  field: 'messages',
                  value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '15550783881', phone_number_id: NUMBER_A },
                    errors: [
                      {
                        code: 131_031,
                        title: 'Account has been locked',
                        message: 'Account locked',
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        try {
          await send(body);

          const [account] = await owner.db
            .select()
            .from(metaAccounts)
            .where(eq(metaAccounts.id, accountA.id));
          expect(account?.lastError).toBe('131031: Account locked');
        } finally {
          await owner.db
            .update(metaAccounts)
            .set({ lastError: null, lastErrorAt: null })
            .where(eq(metaAccounts.id, accountA.id));
        }
      });
    });

    // ------------------------------------------------------------ the gate

    describe('the sender gate', () => {
      it('drops a blocked sender before any contact exists, and counts it', async () => {
        const customer = newCustomer();
        await owner.db
          .insert(blockedSenders)
          .values({ brandId: BRAND_A, kind: 'whatsapp', value: customer.userId });
        const mediaId = `BLOCKED-${customer.userId}`;
        graph.serveMedia(mediaId, JPEG, 'image/jpeg');

        await send(whatsappImage({ ...base(customer), mediaId, sha256: sha256Base64(JPEG) }));

        expect(await contactOf(customer)).toBeUndefined();
        expect(await conversationOf(customer)).toBeUndefined();
        const [row] = await owner.db
          .select({ dropped: blockedSenders.droppedCount })
          .from(blockedSenders)
          .where(eq(blockedSenders.value, customer.userId));
        expect(row?.dropped).toBe(1);
        expect(graph.callsTo(`/${mediaId}`)).toEqual([]);
      });

      it('drops the next message of a customer an agent blocked with Block sender on their ticket', async () => {
        const customer = newCustomer();
        const { ticket } = await openTicket(customer, 'Buy my things');

        // The agent's own route, as the ticket's "Mark as spam" dialog calls it with the box ticked.
        const blocked = await app.inject({
          method: 'POST',
          url: `/api/brands/${BRAND_A}/tickets/${ticket.id}/spam`,
          headers: { [DEV_PRINCIPAL_HEADER]: JSON.stringify(agentA) },
          payload: { blockSender: true },
        });
        expect(blocked.statusCode).toBe(201);
        await say(customer, 'Buy my things, please');

        // What the route blocked is what the gate looks up: the customer's id on the platform.
        const [entry] = await owner.db
          .select()
          .from(blockedSenders)
          .where(
            and(eq(blockedSenders.brandId, BRAND_A), eq(blockedSenders.value, customer.userId)),
          );
        expect(entry).toMatchObject({ kind: 'whatsapp', droppedCount: 1 });
        expect((await messagesOf(ticket.id)).filter((row) => row.kind === 'public')).toHaveLength(
          1,
        );
      });

      it('drops a message from a number an admin blocked by hand', async () => {
        const customer = newCustomer();
        await owner.db
          .insert(blockedSenders)
          .values({ brandId: BRAND_A, kind: 'phone', value: `+${customer.from}` });

        await send(whatsappText({ ...base(customer), text: 'Buy my things' }));

        expect(await contactOf(customer)).toBeUndefined();
        const [row] = await owner.db
          .select({ dropped: blockedSenders.droppedCount })
          .from(blockedSenders)
          .where(eq(blockedSenders.value, `+${customer.from}`));
        expect(row?.dropped).toBe(1);
      });
    });

    // ----------------------------------------------------------- two brands

    describe('a batch for two brands', () => {
      it('files a ticket in each brand, each in its own department and language', async () => {
        const mine = newCustomer();
        const theirs = newCustomer();
        const response = await driver.postBatch([
          whatsappText({ ...base(mine), text: 'Hello Acme' }),
          whatsappLocation({
            wabaId: WABA_B,
            phoneNumberId: NUMBER_B,
            from: theirs.from,
            userId: theirs.userId,
            profileName: theirs.profileName,
            wamid: nextWamid(),
          }),
        ]);
        expect(response.status).toBe(200);

        const [acme] = await ticketsOf(mine, BRAND_A);
        const [globex] = await ticketsOf(theirs, BRAND_B);
        expect(acme).toMatchObject({ brandId: BRAND_A, channel: 'whatsapp' });
        expect(globex).toMatchObject({ brandId: BRAND_B, channel: 'whatsapp' });
        expect(await ticketsOf(mine, BRAND_B)).toEqual([]);
        expect(await ticketsOf(theirs, BRAND_A)).toEqual([]);
        // Globex works in Arabic: the location is filed in the customer's language.
        const [location] = await messagesOf(globex?.id ?? '');
        expect(location?.bodyText).toContain('الموقع');
        expect(location?.bodyText).not.toContain('Location');
      });
    });
  });
});
