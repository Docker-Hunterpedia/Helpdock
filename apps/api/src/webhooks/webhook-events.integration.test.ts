import type { Env } from '@helpdock/config';
import {
  accounts,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  type DbTransaction,
  departments,
  outbox,
  ticketMessages,
  ticketStatuses,
  tickets,
  uuidv7,
  type WebhookDeliveryRow,
  withSystem,
} from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import {
  additionalWebhookDataSchemas,
  type WebhookEnvelope,
  webhookSourcePayloadSchemas,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { AccountsService } from '../contacts/accounts.service.js';
import { ContactMergeService } from '../contacts/contact-merge.service.js';
import { withContactProfileChange } from '../contacts/contact-profile-change.js';
import { ContactsService } from '../contacts/contacts.service.js';
import {
  attachUnverifiedIdentity,
  attachVerifiedIdentity,
  findOrCreateContactByIdentity,
  removeIdentity,
} from '../contacts/identity.js';
import { RequestContext, runInRequestContext } from '../context/request-context.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { MergeService } from '../tickets/merge/merge.service.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { createWebhookSourceHandler, WEBHOOK_DELIVERY_REQUESTED_EVENT } from './webhook-events.js';
import { WebhooksRepository } from './webhooks.repository.js';

/**
 * The webhooks subscriber (M8-03) against real Postgres: what one domain
 * event leaves behind in `webhook_deliveries` and the outbox.
 *
 * 1. **The delivery carries the thing, not its id**: the ticket as the public
 *    API shows it, frozen into the row, one row per endpoint that asked, and
 *    one `webhook.delivery_requested` event per row.
 * 2. **A redelivered event adds nothing** (DOMAIN-RULES §6).
 * 3. **A reply sends the message with its ticket**; a reply whose message
 *    turned out to be a note sends nothing.
 * 4. **A ticket that is gone sends nothing.**
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 83).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const NOW = new Date('2026-10-06T10:00:00Z');

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the webhooks subscriber integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

describe.skipIf(!hasDocker)('the webhooks subscriber (M8-03)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let departmentId: string;
  let openStatusId: string;
  let ticketNumber = 7_000;

  const repository = new WebhooksRepository();
  const handle = createWebhookSourceHandler(repository, () => NOW);

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
      S3_ENDPOINT: 'http://bucket.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'helpdock-webhooks',
      S3_ACCESS_KEY_ID: 'unused',
      S3_SECRET_ACCESS_KEY: 'unused',
      S3_FORCE_PATH_STYLE: true,
      FFMPEG_PATH: 'ffmpeg',
      FFPROBE_PATH: 'ffprobe',
      CLAMAV_PORT: 3310,
      ADMIN_DIST_DIR: '/nonexistent',
      OUTBOUND_ALLOW_CIDRS: [],
    }) as Env;

  const db = (): Db => runtime.db;

  const endpointFor = (events: string[], includeInternalNotes?: boolean): Promise<string> =>
    withSystem(db(), seeded.brandId, async (tx) => {
      const row = await repository.insert(tx, {
        brandId: seeded.brandId,
        url: `https://hooks.example.com/${uuidv7()}`,
        description: '',
        ...(includeInternalNotes === undefined ? {} : { includeInternalNotes }),
        events,
        secret: 'v1.test.sealed',
      });
      return row.id;
    });

  /** One open ticket with one message of the given kind. */
  const seedTicket = async (
    kind: 'public' | 'note' = 'public',
  ): Promise<{ ticketId: string; messageId: string; number: number }> => {
    const ticketId = uuidv7();
    ticketNumber += 1;
    const number = ticketNumber;
    return withSystem(db(), seeded.brandId, async (tx) => {
      await tx.insert(tickets).values({
        id: ticketId,
        brandId: seeded.brandId,
        departmentId,
        number,
        prefix: 'WH',
        subject: `Webhook ticket ${number}`,
        statusId: openStatusId,
        priority: 'high',
        channel: 'email',
        contactId: null,
      });
      const [message] = await tx
        .insert(ticketMessages)
        .values({
          brandId: seeded.brandId,
          ticketId,
          departmentId,
          seq: 1,
          kind,
          authorType: 'staff',
          authorId: seeded.userId,
          bodyHtml: '<p>Your order left the warehouse.</p>',
          bodyText: 'Your order left the warehouse.',
          channel: 'email',
        })
        .returning({ id: ticketMessages.id });
      return { ticketId, messageId: message?.id ?? '', number };
    });
  };

  const run = (
    event: string,
    payload: Record<string, unknown>,
    outboxId = uuidv7(),
  ): Promise<string> =>
    withSystem(db(), seeded.brandId, async (tx) => {
      await handle({ outboxId, brandId: seeded.brandId, event, payload, tx, log: silentLogger });
      return outboxId;
    });

  const deliveriesOf = (webhookId: string): Promise<WebhookDeliveryRow[]> =>
    withSystem(db(), seeded.brandId, (tx) =>
      repository.deliveries(tx, webhookId, { before: undefined, limit: 10 }),
    );

  const requestedDeliveryIds = (): Promise<string[]> =>
    withSystem(db(), seeded.brandId, async (tx) =>
      (
        await tx
          .select({ payload: outbox.payload })
          .from(outbox)
          .where(eq(outbox.event, WEBHOOK_DELIVERY_REQUESTED_EVENT))
      ).map((row) => String(row.payload.deliveryId)),
    );

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
    seeded = await seedDevInstall({ db: db(), env: envFor() });

    [departmentId, openStatusId] = await withSystem(db(), seeded.brandId, async (tx) => {
      const [department] = await tx.select({ id: departments.id }).from(departments).limit(1);
      const [open] = await tx
        .select({ id: ticketStatuses.id })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.name, 'Open'))
        .limit(1);
      return [department?.id ?? '', open?.id ?? ''];
    });
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('freezes the ticket into one delivery per endpoint that asked, and asks for each', async () => {
    const { ticketId, number } = await seedTicket();
    const [first, second, closedOnly] = await Promise.all([
      endpointFor(['ticket.created']),
      endpointFor(['ticket.created', 'ticket.closed']),
      endpointFor(['ticket.closed']),
    ]);

    const outboxId = await run('ticket.created', { ticketId });

    const [delivery] = await deliveriesOf(first);
    expect(delivery).toMatchObject({
      brandId: seeded.brandId,
      webhookId: first,
      eventId: outboxId,
      event: 'ticket.created',
      status: 'pending',
      attempts: 0,
      replayOf: null,
    });
    const envelope = delivery?.payload as unknown as WebhookEnvelope;
    expect(envelope).toMatchObject({
      id: outboxId,
      event: 'ticket.created',
      createdAt: NOW.toISOString(),
      brandId: seeded.brandId,
    });
    expect(envelope.data).toEqual({
      ticket: expect.objectContaining({
        id: ticketId,
        number,
        prefix: 'WH',
        subject: `Webhook ticket ${number}`,
        priority: 'high',
        channel: 'email',
        departmentId,
        status: expect.objectContaining({ id: openStatusId, name: 'Open', systemState: 'open' }),
        tags: [],
      }),
    });
    // The row is the public shape: nothing that only the database knows.
    expect(envelope.data.ticket).not.toHaveProperty('statusId');
    expect(envelope.data.ticket).not.toHaveProperty('deletedAt');

    const [secondDelivery] = await deliveriesOf(second);
    expect(secondDelivery?.payload).toEqual(delivery?.payload);
    expect(await deliveriesOf(closedOnly)).toEqual([]);
    expect(await requestedDeliveryIds()).toEqual(
      expect.arrayContaining([delivery?.id, secondDelivery?.id]),
    );
  });

  it('adds no second delivery when the same event is delivered again', async () => {
    const { ticketId } = await seedTicket();
    const endpoint = await endpointFor(['ticket.updated']);
    const outboxId = uuidv7();

    await run('ticket.updated', { ticketId }, outboxId);
    await run('ticket.updated', { ticketId }, outboxId);

    const deliveries = await deliveriesOf(endpoint);
    expect(deliveries).toHaveLength(1);
    expect((await requestedDeliveryIds()).filter((id) => id === deliveries[0]?.id)).toHaveLength(1);
  });

  it('sends a public reply with its ticket, and nothing for a message that is a note', async () => {
    const replied = await seedTicket('public');
    const noted = await seedTicket('note');
    const endpoint = await endpointFor(['ticket.replied']);

    await run('ticket.replied', { ticketId: replied.ticketId, messageId: replied.messageId });
    await run('ticket.replied', { ticketId: noted.ticketId, messageId: noted.messageId });

    const [delivery, ...more] = await deliveriesOf(endpoint);
    expect(more).toEqual([]);
    const envelope = delivery?.payload as unknown as WebhookEnvelope | undefined;
    expect(envelope?.data).toEqual({
      ticket: expect.objectContaining({ id: replied.ticketId }),
      message: expect.objectContaining({
        id: replied.messageId,
        ticketId: replied.ticketId,
        seq: 1,
        kind: 'public',
        authorType: 'staff',
        authorId: seeded.userId,
        bodyText: 'Your order left the warehouse.',
        channel: 'email',
        attachments: [],
      }),
    });
  });

  it('sends nothing when the ticket the event was about is gone', async () => {
    const { ticketId } = await seedTicket();
    const endpoint = await endpointFor(['ticket.closed']);
    await withSystem(db(), seeded.brandId, (tx) =>
      tx.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, ticketId)),
    );

    await run('ticket.closed', { ticketId });

    expect(await deliveriesOf(endpoint)).toEqual([]);
  });
  it('skips message.created for a soft-deleted ticket', async () => {
    const message = await seedTicket();
    const endpoint = await endpointFor(['message.created']);
    await withSystem(db(), seeded.brandId, (tx) =>
      tx.update(tickets).set({ deletedAt: NOW }).where(eq(tickets.id, message.ticketId)),
    );
    await run('message.created', { ...message, departmentId });
    expect(await deliveriesOf(endpoint)).toEqual([]);
  });

  it('emits contact.updated only when v1 profile data changes, including identities', async () => {
    // Created in its own transaction: a change in the creating transaction is
    // covered by `contact.created` and emits nothing.
    const { contact, receiver } = await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      return {
        contact: await service.create(context, {
          name: 'Profile comparison',
          identities: [{ kind: 'email', value: `${uuidv7()}@example.test` }],
        }),
        receiver: await service.create(context, {
          name: 'Verified identity receiver',
          identities: [],
        }),
      };
    });
    await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      const events = async () =>
        (await tx.select().from(outbox).where(eq(outbox.event, 'contact.updated'))).filter(
          (row) => row.payload.contactId === contact.id,
        );
      await service.update(context, contact.id, { name: contact.name, locale: contact.locale });
      expect(await events()).toHaveLength(0);
      const account = await app
        .get(AccountsService)
        .create(context, { name: 'Unpublished account membership' });
      await service.update(context, contact.id, { accountId: account.id, custom: {} });
      expect(await events()).toHaveLength(0);
      await service.update(context, contact.id, { locale: 'ar' });
      expect(await events()).toHaveLength(1);
      const updated = await service.addIdentity(context, contact.id, {
        kind: 'email',
        value: `${uuidv7()}@example.test`,
      });
      expect(await events()).toHaveLength(2);
      const added = updated.identities.find(
        (row) => !contact.identities.some((old) => old.id === row.id),
      );
      if (added === undefined) throw new Error('Missing new identity');
      await service.removeIdentity(context, contact.id, added.id);
      expect(await events()).toHaveLength(3);
      const claim = {
        kind: 'email' as const,
        value: `${uuidv7()}@example.test`,
        source: 'widget.form' as const,
      };
      await attachUnverifiedIdentity(tx, seeded.brandId, contact.id, claim);
      expect(await events()).toHaveLength(4);
      await attachUnverifiedIdentity(tx, seeded.brandId, contact.id, claim);
      expect(await events()).toHaveLength(4);
      await attachVerifiedIdentity(tx, seeded.brandId, contact.id, {
        ...claim,
        source: 'email.inbound',
      });
      expect(await events()).toHaveLength(5);
      await attachVerifiedIdentity(tx, seeded.brandId, contact.id, {
        ...claim,
        source: 'email.inbound',
      });
      expect(await events()).toHaveLength(5);
      await removeIdentity(tx, seeded.brandId, contact.id, claim);
      expect(await events()).toHaveLength(6);
      await attachUnverifiedIdentity(tx, seeded.brandId, contact.id, claim);
      await attachVerifiedIdentity(tx, seeded.brandId, receiver.id, {
        ...claim,
        source: 'email.inbound',
      });
      expect(await events()).toHaveLength(8);
      const receiverEvents = (
        await tx.select().from(outbox).where(eq(outbox.event, 'contact.updated'))
      ).filter((row) => row.payload.contactId === receiver.id);
      expect(receiverEvents).toHaveLength(1);
    });
  });

  it('serializes simultaneous identity transfers between the same contacts in opposite directions', async () => {
    const pair = await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      const firstEmail = `${uuidv7()}@example.test`;
      const secondEmail = `${uuidv7()}@example.test`;
      const first = await service.create(context, {
        name: 'First transfer',
        identities: [{ kind: 'email', value: firstEmail }],
      });
      const second = await service.create(context, {
        name: 'Second transfer',
        identities: [{ kind: 'email', value: secondEmail }],
      });
      return [
        { contactId: second.id, email: firstEmail },
        { contactId: first.id, email: secondEmail },
      ];
    });
    const transferred = await Promise.all(
      pair.map(({ contactId, email }) =>
        withSystem(db(), seeded.brandId, async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
          return attachVerifiedIdentity(tx, seeded.brandId, contactId, {
            kind: 'email',
            value: email,
            source: 'email.inbound',
          });
        }),
      ),
    );
    expect(transferred.map(({ identity }) => identity)).toEqual(
      pair.map(({ contactId, email }) =>
        expect.objectContaining({ contactId, value: email, verified: true }),
      ),
    );
  });

  const lockContacts = (tx: DbTransaction, ids: string[]) =>
    tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(inArray(contacts.id, ids))
      .orderBy(contacts.id)
      .for('update');
  const waitingOnLocks = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const rows = await owner.db.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = 'helpdock' AND wait_event_type = 'Lock'`,
      );
      if ((rows[0]?.total ?? 0) >= count) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The transactions never queued on the contact locks');
  };

  it('sends no contact.updated for a profile change on a contact created in the same transaction', async () => {
    const contactId = await withSystem(db(), seeded.brandId, async (tx) => {
      const { contact } = await findOrCreateContactByIdentity(
        tx,
        seeded.brandId,
        { kind: 'email', value: `${uuidv7()}@example.test`, source: 'web.form' },
        { name: 'Created and localised' },
      );
      await withContactProfileChange(tx, contact.id, async () => {
        await tx.update(contacts).set({ locale: 'ar' }).where(eq(contacts.id, contact.id));
      });
      return contact.id;
    });
    const eventsFor = (event: string): Promise<number> =>
      withSystem(
        db(),
        seeded.brandId,
        async (tx) =>
          (await tx.select().from(outbox).where(eq(outbox.event, event))).filter(
            (row) => row.payload.contactId === contactId,
          ).length,
      );
    expect(await eventsFor('contact.created')).toBe(1);
    expect(await eventsFor('contact.updated')).toBe(0);

    await withSystem(db(), seeded.brandId, (tx) =>
      withContactProfileChange(tx, contactId, async () => {
        await tx.update(contacts).set({ locale: 'en' }).where(eq(contacts.id, contactId));
      }),
    );
    expect(await eventsFor('contact.updated')).toBe(1);
  });

  it('re-reads the identity holder under the lock and never waits for a lower id while holding higher ones', async () => {
    const email = `${uuidv7()}@example.test`;
    const [low, target, holder] = await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      const first = await service.create(context, { name: 'Race low', identities: [] });
      const second = await service.create(context, { name: 'Race target', identities: [] });
      const third = await service.create(context, {
        name: 'Race holder',
        identities: [{ kind: 'email', value: email }],
      });
      return [first.id, second.id, third.id];
    });
    if (low === undefined || target === undefined || holder === undefined) {
      throw new Error('Missing race contacts');
    }
    expect([low, target, holder]).toEqual([low, target, holder].toSorted());

    // The mover holds the current holder and is about to hand the value to `low`.
    let commitMover: () => void = () => undefined;
    const moverMayCommit = new Promise<void>((resolve) => {
      commitMover = resolve;
    });
    const moverLocked = Promise.withResolvers<void>();
    const mover = withSystem(db(), seeded.brandId, async (tx) => {
      await lockContacts(tx, [holder]);
      await tx
        .update(contactIdentities)
        .set({ contactId: low })
        .where(eq(contactIdentities.value, email));
      moverLocked.resolve();
      await moverMayCommit;
    });
    await moverLocked.promise;

    // Reads `holder` as the holder, takes `target`, then queues for `holder`.
    const attach = withSystem(db(), seeded.brandId, async (tx) => {
      return attachVerifiedIdentity(tx, seeded.brandId, target, {
        kind: 'email',
        value: email,
        source: 'email.inbound',
      });
    });
    await waitingOnLocks(1);

    // A writer that takes its locks in id order: it holds `low`, where the
    // identity is about to land, and queues for `holder`. If the attach kept
    // `target` and `holder` and then asked for `low`, the two would wait on each other.
    const bystander = withSystem(db(), seeded.brandId, async (tx) => {
      await lockContacts(tx, [low]);
      await lockContacts(tx, [low, holder]);
    });
    await waitingOnLocks(2);
    commitMover();

    await mover;
    await bystander;
    const attached = await attach;
    expect(attached).toMatchObject({
      plan: 'move',
      otherContactId: low,
      identity: { contactId: target, verified: true },
    });
  });

  it('moves a proven identifier off the holder it finds under the lock, not the one it read', async () => {
    const email = `${uuidv7()}@example.test`;
    const [lowHolder, readHolder] = await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      const first = await service.create(context, { name: 'Moved to', identities: [] });
      const second = await service.create(context, {
        name: 'Read as holder',
        identities: [{ kind: 'email', value: email }],
      });
      return [first.id, second.id];
    });
    if (lowHolder === undefined || readHolder === undefined) {
      throw new Error('Missing contacts');
    }

    // Hands the value from the contact the claim will read to a lower-id one.
    const moverLocked = Promise.withResolvers<void>();
    const moverMayCommit = Promise.withResolvers<void>();
    const mover = withSystem(db(), seeded.brandId, async (tx) => {
      // NO KEY UPDATE, so the claim's duplicate suggestion (a foreign key on
      // this contact) is not held up and the claim reaches its own lock.
      await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.id, readHolder))
        .for('no key update');
      await tx
        .update(contactIdentities)
        .set({ contactId: lowHolder })
        .where(eq(contactIdentities.value, email));
      moverLocked.resolve();
      await moverMayCommit.promise;
    });
    await moverLocked.promise;

    // Reads `readHolder`, creates its own contact and queues for the lock.
    const claim = withSystem(db(), seeded.brandId, (tx) =>
      findOrCreateContactByIdentity(tx, seeded.brandId, {
        kind: 'email',
        value: email,
        source: 'email.inbound',
      }),
    );
    await waitingOnLocks(1);
    moverMayCommit.resolve();
    await mover;

    const { contact, identity } = await claim;
    expect(identity).toMatchObject({ contactId: contact.id, verified: true });
    const updates = await withSystem(db(), seeded.brandId, async (tx) =>
      (await tx.select().from(outbox).where(eq(outbox.event, 'contact.updated'))).filter(
        (row) => row.payload.contactId === lowHolder,
      ),
    );
    expect(updates).toHaveLength(1);
  });

  it('undoing a contact merge emits exactly one update for each existing contact', async () => {
    const { survivor, restored } = await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      return {
        survivor: await service.create(context, { name: 'Undo survivor', identities: [] }),
        restored: await service.create(context, {
          name: 'Undo restored',
          identities: [{ kind: 'email', value: `${uuidv7()}@example.test` }],
        }),
      };
    });
    await withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const service = app.get(ContactsService);
      const merges = app.get(ContactMergeService);
      const merged = await merges.merge(context, survivor.id, { mergedContactId: restored.id });
      const merge = merged.merges[0];
      if (merge === undefined) throw new Error('Missing active merge');
      const before = new Set((await tx.select().from(outbox)).map((row) => row.id));
      await merges.undo(context, survivor.id, merge.id);
      const events = (await tx.select().from(outbox)).filter((row) => !before.has(row.id));
      expect(events).toHaveLength(2);
      expect(events.map(({ event, payload }) => ({ event, payload }))).toEqual(
        expect.arrayContaining([
          {
            event: 'contact.updated',
            payload: { contactId: survivor.id, departmentId: null },
          },
          {
            event: 'contact.updated',
            payload: { contactId: restored.id, departmentId: null },
          },
        ]),
      );
      expect((await service.detail(context, restored.id)).identities).toHaveLength(1);
      expect((await service.detail(context, survivor.id)).identities).toHaveLength(0);
    });
  });

  /** Committed first, so the later `update` and `merge` are changes to existing contacts. */
  const seedMutationContacts = (suffix: string) =>
    withSystem(db(), seeded.brandId, async (tx) => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const contactService = app.get(ContactsService);
      return {
        first: await contactService.create(context, { name: `Survivor ${suffix}`, identities: [] }),
        second: await contactService.create(context, { name: `Merged ${suffix}`, identities: [] }),
      };
    });

  const mutate = async (
    tx: DbTransaction,
    suffix: string,
    { first, second }: Awaited<ReturnType<typeof seedMutationContacts>>,
  ) => {
    const principal = {
      type: 'staff' as const,
      id: seeded.userId,
      installAdmin: true,
      brands: { [seeded.brandId]: { role: 'admin' as const, departmentIds: 'all' as const } },
    };
    const request = new RequestContext({
      requestId: uuidv7(),
      method: 'POST',
      path: '/test/m14-28',
    });
    request.tx = tx;
    request.principal = principal;
    request.targetBrandId = seeded.brandId;
    return runInRequestContext(request, async () => {
      const context = {
        tx,
        brandId: seeded.brandId,
        actor: { userId: seeded.userId, role: 'admin' as const },
      };
      const contactService = app.get(ContactsService);
      const accountService = app.get(AccountsService);
      const account = await accountService.create(context, { name: `Account ${suffix}` });
      await accountService.update(context, account.id, { name: `Updated ${suffix}` });
      await contactService.update(context, first.id, { name: `Updated contact ${suffix}` });
      await app.get(ContactMergeService).merge(context, first.id, { mergedContactId: second.id });
      const ticketService = app.get(TicketsService);
      const ticket = await ticketService.create(seeded.brandId, principal, {
        subject: `Webhook ${suffix}`,
        departmentId,
        bodyHtml: '<p>Public first reply</p>',
        channel: 'manual',
        assigneeId: seeded.userId,
      });
      const [status] = await tx
        .select()
        .from(ticketStatuses)
        .where(eq(ticketStatuses.systemState, 'closed'))
        .limit(1);
      if (status === undefined) throw new Error('No closed status');
      await ticketService.update(seeded.brandId, principal, ticket.ticket.id, {
        statusId: status.id,
      });
      const note = await ticketService.addMessage(seeded.brandId, principal, ticket.ticket.id, {
        kind: 'note',
        bodyHtml: '<p>Internal note secret</p>',
      });
      const primary = await ticketService.create(seeded.brandId, principal, {
        subject: `Primary ${suffix}`,
        departmentId,
        bodyHtml: '<p>Public primary</p>',
        channel: 'manual',
      });
      await app
        .get(MergeService)
        .merge(seeded.brandId, principal, ticket.ticket.id, { primaryTicketId: primary.ticket.id });
      return {
        accountId: account.id,
        contactId: first.id,
        ticketId: ticket.ticket.id,
        messageId: note.id,
      };
    });
  };

  it('writes every M14-28 event with the actual service mutation, and carries department scope to deliveries', async () => {
    const events = Object.keys(webhookSourcePayloadSchemas);
    const endpoint = await endpointFor(events);
    const before = await withSystem(db(), seeded.brandId, (tx) =>
      tx.select({ id: outbox.id }).from(outbox),
    );
    const beforeIds = new Set(before.map(({ id }) => id));
    const suffix = uuidv7();
    const contactsToChange = await seedMutationContacts(suffix);
    const changed = await withSystem(db(), seeded.brandId, (tx) =>
      mutate(tx, suffix, contactsToChange),
    );
    const emitted = await withSystem(db(), seeded.brandId, (tx) => tx.select().from(outbox));
    const fresh = emitted.filter((row) => !beforeIds.has(row.id) && events.includes(row.event));
    expect(new Set(fresh.map((row) => row.event))).toEqual(new Set(events));
    for (const row of fresh) {
      expect(row.brandId).toBe(seeded.brandId);
      expect(row.payload.departmentId).toBe(
        row.event.startsWith('contact.') || row.event.startsWith('account.') ? null : departmentId,
      );
      expect(JSON.stringify(row.payload)).not.toContain('Internal note secret');
      await run(row.event, row.payload, row.id);
    }
    const deliveries = await withSystem(db(), seeded.brandId, (tx) =>
      repository.deliveries(tx, endpoint, { before: undefined, limit: 100 }),
    );
    expect(deliveries).toHaveLength(fresh.length);
    for (const delivery of deliveries) {
      const name = delivery.event as keyof typeof additionalWebhookDataSchemas;
      expect(additionalWebhookDataSchemas[name].safeParse(delivery.payload.data).success).toBe(
        true,
      );
      expect(delivery.payload).toMatchObject({
        brandId: seeded.brandId,
        departmentId: fresh.find((row) => row.id === delivery.eventId)?.payload.departmentId,
      });
    }
    expect(
      deliveries.find(
        (row) =>
          row.event === 'message.created' &&
          JSON.stringify(row.payload).includes(changed.messageId),
      )?.payload.data,
    ).toMatchObject({ message: { public: false, authorType: 'staff' } });
  });

  it('rolls back every event with its service changes', async () => {
    const suffix = uuidv7();
    const contactsToChange = await seedMutationContacts(suffix);
    const beforeMutation = await withSystem(db(), seeded.brandId, (tx) =>
      tx.select({ id: outbox.id }).from(outbox),
    );
    await expect(
      withSystem(db(), seeded.brandId, async (tx) => {
        await mutate(tx, suffix, contactsToChange);
        throw new Error('rollback all webhook changes');
      }),
    ).rejects.toThrow('rollback all webhook changes');
    await withSystem(db(), seeded.brandId, async (tx) => {
      expect(await tx.select({ id: outbox.id }).from(outbox)).toEqual(beforeMutation);
      expect(
        await tx
          .select()
          .from(accounts)
          .where(eq(accounts.name, `Updated ${suffix}`)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(contacts)
          .where(eq(contacts.name, `Updated contact ${suffix}`)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(tickets)
          .where(eq(tickets.subject, `Webhook ${suffix}`)),
      ).toEqual([]);
    });
  });

  it('freezes notes without either body unless that endpoint opted in, while public replies keep their bodies', async () => {
    const optedOut = await endpointFor(['message.created']);
    const optedIn = await endpointFor(['message.created'], true);
    const note = await seedTicket('note');
    const reply = await seedTicket('public');
    await run('message.created', { ...note, departmentId });
    await run('message.created', { ...reply, departmentId });
    const redacted = await deliveriesOf(optedOut);
    const full = await deliveriesOf(optedIn);
    expect(redacted).toHaveLength(2);
    expect(full).toHaveLength(2);
    const notePayload = redacted.find((row) =>
      JSON.stringify(row.payload).includes(note.messageId),
    )?.payload;
    expect(notePayload?.data).toMatchObject({ message: { public: false, authorType: 'staff' } });
    expect(JSON.stringify(notePayload)).not.toContain('bodyText');
    expect(JSON.stringify(notePayload)).not.toContain('bodyHtml');
    expect(
      full.find((row) => JSON.stringify(row.payload).includes(note.messageId))?.payload.data,
    ).toMatchObject({ message: { bodyText: 'Your order left the warehouse.' } });
    expect(
      redacted.find((row) => JSON.stringify(row.payload).includes(reply.messageId))?.payload.data,
    ).toMatchObject({ message: { public: true, bodyText: 'Your order left the warehouse.' } });
  });
});
