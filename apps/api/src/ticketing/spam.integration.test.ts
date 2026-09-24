import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  blockedSenders,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  ticketActivity,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type {
  BlockedSender,
  BlockedSenderList,
  BrandSettings,
  Ticket,
  TicketDetail,
  TicketSpamSender,
  TicketStatusList,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { isSenderBlocked } from './sender-gate.js';

/**
 * M1-11 against a real Postgres, over real sessions.
 *
 * The unit suites prove each rule decides correctly on values. This proves
 * what only exists once the pieces are together:
 *
 * 1. **"Mark as spam" is one transaction**: the status, the activity rows, the
 *    `ticket.spam` outbox row and, when ticked, the block-list row — or none.
 * 2. **The inbound gate reads what the dialog wrote**, under the brand's
 *    policy, and counts the drop.
 * 3. **Who may do what**: an Agent marks and blocks from a ticket in their own
 *    department only, and cannot read or edit the block list itself.
 *
 * That brand B cannot read, write or delete brand A's block list is the RLS
 * suite's (`packages/db/src/rls.integration.test.ts`, DOMAIN-RULES §1.6).
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 29).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the M1-11 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly error: {
    readonly ticketing?: { readonly reason: string };
    readonly lifecycle?: { readonly reason: string };
  };
}

describe.skipIf(!hasDocker)('spam and the sender block list', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** An Agent of Support. */
  let sam: Person;
  /** An Agent of Billing. */
  let bo: Person;
  /** The install admin. */
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

  const brandPath = () => `/api/brands/${seeded.brandId}`;

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

  /** A contact with one address, unique to the test that asked. */
  const addContact = async (address: string): Promise<string> =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({ brandId: seeded.brandId, name: address })
        .returning({ id: contacts.id });
      const id = contact?.id ?? '';
      await tx.insert(contactIdentities).values({
        brandId: seeded.brandId,
        contactId: id,
        kind: 'email',
        value: address,
        source: 'test',
      });

      return id;
    });

  const createTicket = async (who: Person, contactId?: string): Promise<Ticket> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, who, {
      subject: 'Crypto giveaway',
      bodyHtml: '<p>Claim your prize</p>',
      departmentId: support,
      channel: 'email',
      ...(contactId === undefined ? {} : { contactId }),
    });

    expect(response.status).toBe(201);
    return response.body.ticket;
  };

  const outboxEventsFor = async (ticketId: string): Promise<string[]> => {
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select({ event: outbox.event })
        .from(outbox)
        .where(sql`${outbox.payload}->>'ticketId' = ${ticketId}`)
        .orderBy(outbox.createdAt),
    );

    return rows.map((row) => row.event);
  };

  const activityFor = async (ticketId: string): Promise<string[]> => {
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select({ action: ticketActivity.action })
        .from(ticketActivity)
        .where(eq(ticketActivity.ticketId, ticketId))
        .orderBy(ticketActivity.createdAt),
    );

    return rows.map((row) => row.action);
  };

  let sequence = 0;
  const address = (local: string): string => {
    sequence += 1;
    return `${local}-${sequence}@promo-deals-${sequence}.biz`;
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
    // What the brand sends from: the domain it may not block.
    await runtime.settings.set('smtp.from', 'support@helpdock.test', { updatedBy: 'test' });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    sam = await addPerson(runtime.db, 'sam');
    bo = await addPerson(runtime.db, 'bo');

    await withSystem(runtime.db, seeded.brandId, async (tx) => {
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
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('seeds exactly one status that is spam, and serves the flag', async () => {
    const list = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, sam);

    const spam = list.body.statuses.filter((status) => status.isSpam);
    expect(spam).toHaveLength(1);
    expect(spam[0]).toMatchObject({ systemState: 'closed', excludedFromReports: true });
  });

  describe('marking a ticket as spam', () => {
    it('closes it into Spam, blocks the sender, and writes it all in one transaction', async () => {
      const sender = address('winner');
      const ticket = await createTicket(sam, await addContact(sender));

      const offer = await call<TicketSpamSender>(
        'GET',
        `${brandPath()}/tickets/${ticket.id}/spam-sender`,
        sam,
      );
      expect(offer.body).toEqual({
        sender: { kind: 'email', value: sender },
        offered: true,
        blockable: true,
        blocked: false,
      });

      const marked = await call<Ticket>('POST', `${brandPath()}/tickets/${ticket.id}/spam`, sam, {
        blockSender: true,
      });

      expect(marked.status).toBe(201);
      expect(marked.body.status.isSpam).toBe(true);
      expect(marked.body.closedAt).not.toBeNull();
      expect(await activityFor(ticket.id)).toEqual([
        'ticket.created',
        'ticket.status.changed',
        'ticket.marked_spam',
      ]);
      // `ticket.spam`, never `ticket.closed`: a survey must not hear a close.
      expect(await outboxEventsFor(ticket.id)).toEqual(['ticket.created', 'ticket.spam']);

      const row = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(blockedSenders).where(eq(blockedSenders.value, sender)),
      );
      expect(row).toEqual([
        expect.objectContaining({ kind: 'email', createdBy: sam.id, sourceTicketId: ticket.id }),
      ]);

      const audited = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ meta: auditLog.meta })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'blocked_sender.created'),
              eq(auditLog.targetId, row[0]?.id ?? ''),
            ),
          ),
      );
      // The kind and the ticket, never the address.
      expect(audited[0]?.meta).toEqual({ kind: 'email', sourceTicketId: ticket.id });

      const again = await call<TicketSpamSender>(
        'GET',
        `${brandPath()}/tickets/${ticket.id}/spam-sender`,
        sam,
      );
      expect(again.body.blocked).toBe(true);
    });

    it('drops the sender’s next message at the inbound gate, and counts it', async () => {
      const sender = address('again');
      const ticket = await createTicket(sam, await addContact(sender));
      await call('POST', `${brandPath()}/tickets/${ticket.id}/spam`, sam, { blockSender: true });

      const verdict = await withTenant(
        runtime.db,
        {
          brandIds: [seeded.brandId],
          departmentIds: 'all',
          principalType: 'system',
          principalId: 'email.poll',
        },
        (tx) => isSenderBlocked(tx, seeded.brandId, { kind: 'email', value: sender.toUpperCase() }),
      );
      expect(verdict.blocked).toBe(true);

      const list = await call<BlockedSenderList>('GET', `${brandPath()}/blocked-senders`, ada);
      const listed = list.body.senders.find((row) => row.value === sender);
      expect(listed).toMatchObject({ droppedCount: 1, createdByName: 'sam' });
      expect(listed?.lastDroppedAt).not.toBeNull();
    });

    it('marks without blocking when the box was left unticked', async () => {
      const sender = address('unticked');
      const ticket = await createTicket(sam, await addContact(sender));

      await call('POST', `${brandPath()}/tickets/${ticket.id}/spam`, sam, {});

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(blockedSenders).where(eq(blockedSenders.value, sender)),
      );
      expect(rows).toEqual([]);
    });

    it('refuses to block the brand’s own address, and rolls the mark back with it', async () => {
      const ticket = await createTicket(sam, await addContact('lina@helpdock.test'));

      const offer = await call<TicketSpamSender>(
        'GET',
        `${brandPath()}/tickets/${ticket.id}/spam-sender`,
        sam,
      );
      expect(offer.body.blockable).toBe(false);

      const refused = await call<Refusal>('POST', `${brandPath()}/tickets/${ticket.id}/spam`, sam, {
        blockSender: true,
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.ticketing?.reason).toBe('sender-is-own');
      expect(await activityFor(ticket.id)).toEqual(['ticket.created']);
    });

    it('is a 404 to an Agent of another department, as the ticket itself is', async () => {
      const ticket = await createTicket(sam);

      const refused = await call('POST', `${brandPath()}/tickets/${ticket.id}/spam`, bo, {});

      expect(refused.status).toBe(404);
    });

    it('sends ticket.spam when an agent picks Spam from the status picker too', async () => {
      const ticket = await createTicket(sam);
      const statuses = await call<TicketStatusList>('GET', `${brandPath()}/ticket-statuses`, sam);
      const spam = statuses.body.statuses.find((status) => status.isSpam);

      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, sam, { statusId: spam?.id });

      expect(await outboxEventsFor(ticket.id)).toEqual(['ticket.created', 'ticket.spam']);
    });
  });

  describe('"Not spam"', () => {
    it('reopens the ticket to the default open status', async () => {
      const ticket = await createTicket(sam);
      await call('POST', `${brandPath()}/tickets/${ticket.id}/spam`, sam, {});

      const restored = await call<Ticket>(
        'DELETE',
        `${brandPath()}/tickets/${ticket.id}/spam`,
        sam,
      );

      expect(restored.status).toBe(200);
      expect(restored.body.status).toMatchObject({ isDefault: true, isSpam: false });
      expect(restored.body.closedAt).toBeNull();
      expect(await outboxEventsFor(ticket.id)).toEqual([
        'ticket.created',
        'ticket.spam',
        'ticket.reopened',
      ]);
    });

    it('refuses a ticket that is not spam', async () => {
      const ticket = await createTicket(sam);

      const refused = await call<Refusal>(
        'DELETE',
        `${brandPath()}/tickets/${ticket.id}/spam`,
        sam,
      );

      expect(refused.status).toBe(409);
      expect(refused.body.error.lifecycle?.reason).toBe('ticket-not-closed');
    });
  });

  describe('the block list', () => {
    it('is the business of ticketing:manage alone', async () => {
      expect((await call('GET', `${brandPath()}/blocked-senders`, sam)).status).toBe(403);
      expect(
        (
          await call('POST', `${brandPath()}/blocked-senders`, sam, {
            kind: 'domain',
            value: 'x.biz',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await call('PATCH', `${brandPath()}/ticketing/spam-settings`, sam, {
            offerBlockSender: false,
          })
        ).status,
      ).toBe(403);
    });

    it('blocks a domain, refuses it twice, and unblocks it', async () => {
      const created = await call<BlockedSender>('POST', `${brandPath()}/blocked-senders`, ada, {
        kind: 'domain',
        value: '@Crypto-Bots.BIZ',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ kind: 'domain', value: 'crypto-bots.biz' });

      const twice = await call<Refusal>('POST', `${brandPath()}/blocked-senders`, ada, {
        kind: 'domain',
        value: 'crypto-bots.biz',
      });
      expect(twice.status).toBe(409);
      expect(twice.body.error.ticketing?.reason).toBe('sender-already-blocked');

      const removed = await call(
        'DELETE',
        `${brandPath()}/blocked-senders/${created.body.id}`,
        ada,
      );
      expect(removed.status).toBe(204);

      const list = await call<BlockedSenderList>('GET', `${brandPath()}/blocked-senders`, ada);
      expect(list.body.senders.some((row) => row.id === created.body.id)).toBe(false);
    });

    it('refuses the domain the brand sends from, and a value that is not one', async () => {
      const own = await call<Refusal>('POST', `${brandPath()}/blocked-senders`, ada, {
        kind: 'domain',
        value: 'helpdock.test',
      });
      expect(own.status).toBe(409);
      expect(own.body.error.ticketing?.reason).toBe('sender-is-own');

      const invalid = await call<Refusal>('POST', `${brandPath()}/blocked-senders`, ada, {
        kind: 'telegram',
        value: '@crypto_bot_9',
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.ticketing?.reason).toBe('sender-invalid');
    });

    it('stops offering "Block sender" once the brand turns it off', async () => {
      const off = await call<BrandSettings>(
        'PATCH',
        `${brandPath()}/ticketing/spam-settings`,
        ada,
        {
          offerBlockSender: false,
        },
      );
      expect(off.body.offerBlockSender).toBe(false);

      const ticket = await createTicket(sam, await addContact(address('late')));
      const offer = await call<TicketSpamSender>(
        'GET',
        `${brandPath()}/tickets/${ticket.id}/spam-sender`,
        sam,
      );
      expect(offer.body.offered).toBe(false);

      const refused = await call('POST', `${brandPath()}/tickets/${ticket.id}/spam`, sam, {
        blockSender: true,
      });
      expect(refused.status).toBe(409);

      await call('PATCH', `${brandPath()}/ticketing/spam-settings`, ada, {
        offerBlockSender: true,
      });
    });
  });
});
