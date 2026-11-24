import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  brands,
  contactIdentities,
  contactMerges,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  ticketMessages,
  ticketParticipants,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type { ContactDetail, TicketDetail, TicketMessage } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { loadImportedParticipants } from '../imports/loader/load-participants.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';
import { loadCustomerScope } from './customer-context.js';

/**
 * A ticket's participants (M1-13, DOMAIN-RULES §2.5) against a real Postgres.
 *
 * What only a database can prove: that `ticket_participants` is
 * department-scoped like every other child of a ticket (an Agent of Billing can
 * neither read nor add the CCs of a Support ticket, over HTTP or in SQL), that
 * a CC follows its ticket to another department, and that a change leaves an
 * activity row and an outbox row in the same transaction.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
const AGENT_PASSWORD = 'an agent password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the participants integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('the portal audience through the real services (M21-01)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  let ada: Person;
  let bo: Person;
  let mona: string;
  let yusuf: string;
  let kim: string;

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

  const signIn = (email: string, password: string): Promise<string> =>
    signInForTest(app, { email, password });

  const ticketPath = (ticketId: string) => `${brandPath()}/tickets/${ticketId}`;

  const createTicket = async (contactId: string): Promise<string> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'Invoice copy',
      bodyHtml: '<p>Please send the invoice.</p>',
      departmentId: support,
      contactId,
    });
    expect(response.status).toBe(201);

    return response.body.ticket.id;
  };

  /** What the portal policies read, straight from the rows. */
  const audience = (ticketId: string) =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [ticket] = await tx
        .select({
          ids: tickets.portalContactIds,
          eligible: tickets.portalEligible,
          account: tickets.accountId,
        })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      const messages = await tx
        .select({ kind: ticketMessages.kind, ids: ticketMessages.portalContactIds })
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, ticketId));

      return { ticket: ticket?.ids ?? [], eligible: ticket?.eligible, messages };
    });

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
    await seed(runtime.db);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

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

  const seed = async (db: Db): Promise<void> => {
    ada = { id: seeded.userId, email: seeded.email, token: '' };
    bo = await addPerson(db, 'bo');

    await withSystem(db, seeded.brandId, async (tx) => {
      const created = await tx
        .insert(departments)
        .values([
          { brandId: seeded.brandId, name: 'Support' },
          { brandId: seeded.brandId, name: 'Billing' },
        ])
        .returning({ id: departments.id, name: departments.name });

      support = created.find((row) => row.name === 'Support')?.id ?? '';
      billing = created.find((row) => row.name === 'Billing')?.id ?? '';

      await tx.insert(userBrandRoles).values({
        userId: bo.id,
        brandId: seeded.brandId,
        role: 'agent',
        departmentIds: [billing],
      });

      const make = async (name: string, email: string): Promise<string> => {
        const [contact] = await tx
          .insert(contacts)
          .values({ brandId: seeded.brandId, name })
          .returning({ id: contacts.id });
        const id = contact?.id ?? '';
        await tx.insert(contactIdentities).values({
          brandId: seeded.brandId,
          contactId: id,
          kind: 'email',
          value: email,
          verified: true,
          source: 'email.inbound',
        });
        return id;
      };
      mona = await make('Mona', 'mona@example.com');
      yusuf = await make('Yusuf', 'yusuf@example.com');
      kim = await make('Kim', 'kim@example.com');
    });

    ada.token = await signIn(seeded.email, seeded.password);
    bo.token = await signIn(bo.email, AGENT_PASSWORD);
  };

  it('follows a contact merge and its undo', async () => {
    const ticketId = await createTicket(mona);
    expect((await audience(ticketId)).ticket).toEqual([mona]);

    const merged = await call<ContactDetail>(
      'POST',
      `${brandPath()}/contacts/${yusuf}/merge`,
      ada,
      { mergedContactId: mona },
    );
    expect(merged.status).toBe(201);
    const after = await audience(ticketId);
    expect(after.ticket).toEqual([yusuf]);
    expect(after.messages.every((m) => m.ids.length === 1 && m.ids[0] === yusuf)).toBe(true);

    const [record] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(contactMerges).orderBy(desc(contactMerges.createdAt)).limit(1),
    );
    const undone = await call<ContactDetail>(
      'POST',
      `${brandPath()}/contacts/${yusuf}/merges/${record?.id}/undo`,
      ada,
    );
    expect(undone.status).toBe(201);
    expect((await audience(ticketId)).ticket).toEqual([mona]);
  });

  it('counts a ticket merge’s CC, hides the secondary, and restores it on unmerge', async () => {
    const secondary = await createTicket(mona);
    const primary = await createTicket(yusuf);

    const merged = await call('POST', `${ticketPath(secondary)}/merge`, ada, {
      primaryTicketId: primary,
    });
    expect(merged.status).toBe(200);
    // The CC the merge added has source 'merge', a staff action, so Mona's
    // verified address now reaches the primary too.
    expect((await audience(primary)).ticket.sort()).toEqual([mona, yusuf].sort());
    const hidden = await audience(secondary);
    expect(hidden.eligible).toBe(false);
    expect(hidden.ticket).toEqual([]);
    expect(hidden.messages.every((m) => m.ids.length === 0)).toBe(true);

    await call('POST', `${ticketPath(secondary)}/unmerge`, ada);
    expect((await audience(secondary)).ticket).toEqual([mona]);
  });

  it('counts a CC an agent adds only once its identity is verified, and not after it is taken away', async () => {
    const ticketId = await createTicket(mona);
    await call('POST', `${ticketPath(ticketId)}/participants`, ada, { email: 'kim@example.com' });

    // Kim's identity is verified in the seed, so the agent's CC counts at once.
    expect((await audience(ticketId)).ticket.sort()).toEqual([mona, kim].sort());

    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .update(contactIdentities)
        .set({ verified: false })
        .where(eq(contactIdentities.contactId, kim)),
    );
    expect((await audience(ticketId)).ticket).toEqual([mona]);
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .update(contactIdentities)
        .set({ verified: true })
        .where(eq(contactIdentities.contactId, kim)),
    );
  });

  it('gives a split ticket and its copied messages the requester’s audience, and leaves the original', async () => {
    const original = await createTicket(mona);
    const second = await call<TicketMessage>('POST', `${ticketPath(original)}/messages`, ada, {
      kind: 'public',
      bodyHtml: '<p>Separately, the gasket leaks</p>',
    });
    expect(second.status).toBe(201);

    const split = await call<TicketDetail>('POST', `${ticketPath(original)}/split`, ada, {
      messageIds: [second.body.id],
      subject: 'Gasket leak',
      departmentId: support,
    });
    expect(split.status).toBe(201);

    const created = await audience(split.body.ticket.id);
    expect(created.ticket).toEqual([mona]);
    const copied = created.messages.filter((m) => m.kind === 'public');
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((m) => m.ids[0] === mona)).toBe(true);
    expect((await audience(original)).ticket).toEqual([mona]);
  });

  it('drops an erased contact from the tickets they were copied in on, and refuses their portal context', async () => {
    const ticketId = await createTicket(mona);
    await call('POST', `${ticketPath(ticketId)}/participants`, ada, { email: 'kim@example.com' });
    expect((await audience(ticketId)).ticket).toContain(kim);

    const erased = await call<ContactDetail>(
      'POST',
      `${brandPath()}/contacts/${kim}/anonymise`,
      ada,
    );
    expect(erased.status).toBe(201);

    expect((await audience(ticketId)).ticket).toEqual([mona]);
    await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .update(brands)
        .set({ settings: { portal: { enabled: true } } })
        .where(eq(brands.id, seeded.brandId)),
    );
    await expect(
      loadCustomerScope(runtime.db, { brandId: seeded.brandId, contactId: kim }),
    ).rejects.toMatchObject({ reason: 'contact-unavailable' });
  });

  it('does not put a CC an import loads in the audience', async () => {
    const ticketId = await createTicket(mona);
    const rex = uuidv7();
    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      await tx.insert(contacts).values({ id: rex, brandId: seeded.brandId, name: 'Rex' });
      await tx.insert(contactIdentities).values({
        brandId: seeded.brandId,
        contactId: rex,
        kind: 'email',
        value: 'rex@example.com',
        verified: true,
        source: 'import',
      });
      await loadImportedParticipants(
        tx,
        {
          brandId: seeded.brandId,
          record: { ccEmails: ['rex@example.com'] },
          resolved: { contactId: mona, departmentId: support, ccContacts: [] },
        } as unknown as Parameters<typeof loadImportedParticipants>[1],
        ticketId,
      );
    });

    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select({ source: ticketParticipants.source })
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, ticketId)),
    );
    expect(rows).toEqual([{ source: 'import' }]);
    expect((await audience(ticketId)).ticket).toEqual([mona]);
  });
});
