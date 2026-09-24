import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  ticketActivity,
  ticketParticipants,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type { ContactDetail, TicketDetail, TicketParticipantList } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { ParticipantsRepository } from './participants.repository.js';
import { TicketParticipantsService } from './ticket-participants.service.js';

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

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

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

describe.skipIf(!hasDocker)('ticket participants', () => {
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
  let contactId: string;

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
  const participantsPath = (ticketId: string) => `${brandPath()}/tickets/${ticketId}/participants`;

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

  const createTicket = async (departmentId = support): Promise<string> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, ada, {
      subject: 'Invoice copy',
      bodyHtml: '<p>Please send the invoice to finance too.</p>',
      departmentId,
      contactId,
    });
    expect(response.status).toBe(201);

    return response.body.ticket.id;
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

      const [contact] = await tx
        .insert(contacts)
        .values({ brandId: seeded.brandId, name: 'Mona Khalil' })
        .returning({ id: contacts.id });
      contactId = contact?.id ?? '';
      await tx.insert(contactIdentities).values({
        brandId: seeded.brandId,
        contactId,
        kind: 'email',
        value: 'mona@example.com',
        verified: true,
        source: 'email.inbound',
      });
    });

    ada.token = await signIn(seeded.email, seeded.password);
    bo.token = await signIn(bo.email, AGENT_PASSWORD);
  };

  it('lists the contact and the staff who wrote, with no CCs yet', async () => {
    const ticketId = await createTicket();

    const list = await call<TicketParticipantList>('GET', participantsPath(ticketId), ada);

    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      contact: { id: contactId, name: 'Mona Khalil' },
      ccs: [],
      staff: [{ userId: ada.id }],
    });
  });

  it('adds a CC by address once, with an activity row and an outbox row', async () => {
    const ticketId = await createTicket();

    const added = await call<TicketParticipantList>('POST', participantsPath(ticketId), ada, {
      email: ' Finance@Acme.DE ',
    });
    const again = await call<TicketParticipantList>('POST', participantsPath(ticketId), ada, {
      email: 'finance@acme.de',
    });

    expect(added.status).toBe(201);
    expect(added.body.ccs).toMatchObject([
      { address: 'finance@acme.de', name: 'finance@acme.de', source: 'agent' },
    ]);
    expect(again.body.ccs).toHaveLength(1);

    const [activityRows, events] = await withSystem(runtime.db, seeded.brandId, async (tx) => [
      await tx
        .select()
        .from(ticketActivity)
        .where(
          and(
            eq(ticketActivity.ticketId, ticketId),
            eq(ticketActivity.action, 'ticket.participants.changed'),
          ),
        ),
      await tx
        .select()
        .from(outbox)
        .where(
          sql`${outbox.payload}->>'ticketId' = ${ticketId} AND ${outbox.event} = 'ticket.updated'`,
        ),
    ]);
    expect(activityRows).toHaveLength(1);
    expect(JSON.stringify(activityRows[0]?.to)).not.toContain('@');
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("does not list the ticket's own contact as a CC", async () => {
    const ticketId = await createTicket();

    const added = await call<TicketParticipantList>('POST', participantsPath(ticketId), ada, {
      email: 'mona@example.com',
    });

    expect(added.body.ccs).toEqual([]);
  });

  it('refuses an address that is not one', async () => {
    const ticketId = await createTicket();

    const refused = await call<{ error: { contact?: { reason: string; problem?: string } } }>(
      'POST',
      participantsPath(ticketId),
      ada,
      { email: 'not an address' },
    );

    expect(refused.status).toBe(400);
    expect(refused.body.error.contact).toMatchObject({
      reason: 'identity-invalid',
      problem: 'invalid-email',
    });
  });

  it('removes a CC, and answers 404 for one that is not there', async () => {
    const ticketId = await createTicket();
    const added = await call<TicketParticipantList>('POST', participantsPath(ticketId), ada, {
      email: 'ops@acme.de',
    });
    const participantId = added.body.ccs[0]?.id ?? '';

    const removed = await call<TicketParticipantList>(
      'DELETE',
      `${participantsPath(ticketId)}/${participantId}`,
      ada,
    );
    const missing = await call('DELETE', `${participantsPath(ticketId)}/${participantId}`, ada);

    expect(removed.body.ccs).toEqual([]);
    expect(missing.status).toBe(404);
  });

  it('hides a Support ticket’s CCs from an Agent of Billing, over HTTP and in SQL', async () => {
    const ticketId = await createTicket(support);
    await call('POST', participantsPath(ticketId), ada, { email: 'hidden@acme.de' });

    const read = await call('GET', participantsPath(ticketId), bo);
    const write = await call('POST', participantsPath(ticketId), bo, { email: 'x@acme.de' });
    expect(read.status).toBe(404);
    expect(write.status).toBe(404);

    const scope = {
      brandIds: [seeded.brandId],
      departmentIds: [billing],
      principalType: 'staff',
      principalId: bo.id,
    } as const;
    const rows = await withTenant(runtime.db, scope, (tx) =>
      tx.select().from(ticketParticipants).where(eq(ticketParticipants.ticketId, ticketId)),
    );
    expect(rows).toEqual([]);

    const refused = await withTenant(runtime.db, scope, (tx) =>
      tx.insert(ticketParticipants).values({
        brandId: seeded.brandId,
        ticketId,
        contactId,
        departmentId: billing,
        address: 'mona@example.com',
        source: 'agent',
      }),
    ).then(
      () => undefined,
      (error: unknown) => error as { cause?: { message?: string } },
    );
    expect(refused?.cause?.message).toMatch(/not visible in this transaction/i);
  });

  it('takes its CCs along when the ticket moves department', async () => {
    const ticketId = await createTicket(support);
    await call('POST', participantsPath(ticketId), ada, { email: 'moves@acme.de' });

    await call('PATCH', `${brandPath()}/tickets/${ticketId}`, ada, { departmentId: billing });

    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(ticketParticipants).where(eq(ticketParticipants.ticketId, ticketId)),
    );
    expect(rows.map((row) => row.departmentId)).toEqual([billing]);
    expect((await call('GET', participantsPath(ticketId), bo)).status).toBe(200);
  });

  it('shows the surviving contact for a CC whose contact was merged', async () => {
    const ticketId = await createTicket();
    const added = await call<TicketParticipantList>('POST', participantsPath(ticketId), ada, {
      email: 'assistant@acme.de',
    });
    const ccContactId = added.body.ccs[0]?.contactId ?? '';
    const survivor = await call<ContactDetail>('POST', `${brandPath()}/contacts`, ada, {
      name: 'Rana, assistant',
    });

    await call('POST', `${brandPath()}/contacts/${survivor.body.id}/merge`, ada, {
      mergedContactId: ccContactId,
    });

    const list = await call<TicketParticipantList>('GET', participantsPath(ticketId), ada);
    // The address the CC was added under is kept: a merge never changes who
    // may thread into the ticket.
    expect(list.body.ccs).toMatchObject([
      { contactId: survivor.body.id, name: 'Rana, assistant', address: 'assistant@acme.de' },
    ]);
  });

  it('copies a contact in by id for a ticket merge, once', async () => {
    const ticketId = await createTicket();
    const service = new TicketParticipantsService(new ParticipantsRepository());
    const [secondary] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .insert(contacts)
        .values({ brandId: seeded.brandId, name: 'Secondary contact' })
        .returning({ id: contacts.id }),
    );
    const principal = { type: 'system', brandId: seeded.brandId, jobId: 'test' } as const;

    const [first, second, own] = await withSystem(runtime.db, seeded.brandId, async (tx) => {
      const context = { tx, brandId: seeded.brandId, principal };
      return [
        await service.addCcParticipant(context, ticketId, secondary?.id ?? ''),
        await service.addCcParticipant(context, ticketId, secondary?.id ?? ''),
        await service.addCcParticipant(context, ticketId, contactId),
      ];
    });

    expect([first, second, own]).toEqual([true, false, false]);
    const list = await call<TicketParticipantList>('GET', participantsPath(ticketId), ada);
    expect(list.body.ccs).toMatchObject([
      { contactId: secondary?.id, source: 'merge', address: null },
    ]);
  });
});
