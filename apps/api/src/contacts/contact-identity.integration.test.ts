import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  contactIdentities,
  contactMerges,
  createDb,
  type Db,
  type DbHandle,
  departments,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type {
  Account,
  ContactDetail,
  ContactList,
  ContactMergePreview,
  TicketDetail,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { findOrCreateContactByIdentity } from './identity.js';

/**
 * M1-13 against a real Postgres, over real sessions: the identity rules of
 * DOMAIN-RULES §4.4 and the manual merge with its 24-hour undo.
 *
 * What only a database can prove:
 *
 * 1. **Auto-merge needs proof on both sides.** A verified claim meeting a typed
 *    address starts a new contact that takes the address; a typed claim never
 *    joins anybody.
 * 2. **A merge moves every ticket**, including one in a department the merging
 *    Agent cannot see, and the undo moves exactly those back.
 * 3. **Verification never upgrades by merging**, and a merged contact is
 *    closed to writes and absent from lists.
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
    'Skipping the M1-13 contact integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly error: { readonly contact?: { readonly reason: string } };
}

describe.skipIf(!hasDocker)('contact identity rules and merge', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** An Agent of Support alone: Billing's tickets are hidden from him. */
  let sam: Person;
  let vic: Person;
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

  const contactsPath = () => `/api/brands/${seeded.brandId}/contacts`;

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

  let unique = 0;
  const address = (prefix: string): string => {
    unique += 1;
    return `${prefix}-${unique}@example.com`;
  };

  const createContact = async (body: Record<string, unknown>): Promise<ContactDetail> => {
    const response = await call<ContactDetail>('POST', contactsPath(), ada, body);
    expect(response.status).toBe(201);

    return response.body;
  };

  const detail = async (contactId: string, who: Person = ada): Promise<ContactDetail> => {
    const response = await call<ContactDetail>('GET', `${contactsPath()}/${contactId}`, who);
    expect(response.status).toBe(200);

    return response.body;
  };

  const createTicket = async (
    contactId: string,
    departmentId: string,
  ): Promise<TicketDetail['ticket']> => {
    const response = await call<TicketDetail>(
      'POST',
      `/api/brands/${seeded.brandId}/tickets`,
      ada,
      {
        subject: 'Where is my refund?',
        bodyHtml: '<p>Order 42</p>',
        departmentId,
        contactId,
      },
    );
    expect(response.status).toBe(201);

    return response.body.ticket;
  };

  const ticketContact = async (ticketId: string): Promise<string | null> => {
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select({ contactId: tickets.contactId }).from(tickets).where(eq(tickets.id, ticketId)),
    );

    return rows[0]?.contactId ?? null;
  };

  /** Two contacts of one person, an open suggestion between them, and tickets on both. */
  const pairWithHistory = async () => {
    const survivor = await createContact({
      name: 'Mona Khalil',
      identities: [{ kind: 'email', value: address('mona') }],
    });
    const typed = address('mona.typed');
    await withSystem(runtime.db, seeded.brandId, async (tx) => {
      await findOrCreateContactByIdentity(tx, seeded.brandId, {
        kind: 'email',
        value: typed,
        source: 'email.inbound',
      });
    });
    const [held] = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(contactIdentities).where(eq(contactIdentities.value, typed)),
    );
    const mergedId = held?.contactId ?? '';

    const visible = await createTicket(mergedId, support);
    const hidden = await createTicket(mergedId, billing);

    return { survivor, mergedId, visible, hidden, typed };
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
    sam = await addPerson(db, 'sam');
    vic = await addPerson(db, 'vic');

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

      await tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: seeded.brandId, role: 'agent', departmentIds: [support] },
        { userId: vic.id, brandId: seeded.brandId, role: 'viewer', departmentIds: [support] },
      ]);
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, AGENT_PASSWORD);
    vic.token = await signIn(vic.email, AGENT_PASSWORD);
  };

  // ------------------------------------------------------------- identity

  describe('the identity rules (DOMAIN-RULES §4.4)', () => {
    it('gives a proven address to a new contact rather than joining the one that typed it', async () => {
      const value = address('typed');
      const typist = await createContact({
        name: 'Typed it',
        identities: [{ kind: 'email', value }],
      });

      const inbound = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value,
          source: 'email.inbound',
        }),
      );

      expect(inbound.created).toBe(true);
      expect(inbound.contact.id).not.toBe(typist.id);
      expect(inbound.duplicateOf).toBe(typist.id);
      expect(inbound.identity).toMatchObject({ contactId: inbound.contact.id, verified: true });
      expect((await detail(typist.id)).identities).toEqual([]);
      expect((await detail(inbound.contact.id)).duplicates).toMatchObject([
        { reason: 'email', other: { id: typist.id } },
      ]);
    });

    it('never matches on a phone number, which nothing in v1 verifies', async () => {
      const first = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'phone',
          value: '+49 30 555 0101',
          source: 'widget.form',
        }),
      );
      const second = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'phone',
          value: '+4930 5550101',
          source: 'widget.form',
        }),
      );

      expect(first.identity?.verified).toBe(false);
      expect(second.contact.id).not.toBe(first.contact.id);
      expect((await detail(second.contact.id)).duplicates).toMatchObject([{ reason: 'phone' }]);
    });

    it('suggests two contacts under one account whose names read alike', async () => {
      const account = await call<Account>('POST', `/api/brands/${seeded.brandId}/accounts`, ada, {
        name: `Acme ${uuidv7()}`,
      });
      const full = await createContact({ name: 'Mona Khalil', accountId: account.body.id });
      const short = await createContact({ name: 'Mona K.', accountId: account.body.id });
      await createContact({ name: 'Omar Haddad', accountId: account.body.id });

      const suggestions = (await detail(short.id)).duplicates;

      expect(suggestions).toMatchObject([
        { reason: 'similar_name', other: { id: full.id }, sameAccount: true },
      ]);
    });

    it('does not raise a dismissed pair again from the other direction', async () => {
      const value = address('lena');
      const original = await createContact({
        name: 'Lena Berg',
        identities: [{ kind: 'email', value }],
      });
      const newcomer = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(
          tx,
          seeded.brandId,
          { kind: 'email', value, source: 'widget.form' },
          { name: 'Lena Berg' },
        ),
      );
      const suggestionId = (await detail(newcomer.contact.id)).duplicates[0]?.id ?? '';
      await call(
        'POST',
        `${contactsPath()}/${newcomer.contact.id}/duplicates/${suggestionId}/dismiss`,
        ada,
      );

      // Filing both under one account asks again, by name this time, and in
      // the opposite direction: "Not the same" already answered for the pair.
      const account = await call<Account>('POST', `/api/brands/${seeded.brandId}/accounts`, ada, {
        name: `Berg ${uuidv7()}`,
      });
      await call('PATCH', `${contactsPath()}/${newcomer.contact.id}`, ada, {
        accountId: account.body.id,
      });
      await call('PATCH', `${contactsPath()}/${original.id}`, ada, { accountId: account.body.id });

      expect((await detail(original.id)).duplicates).toEqual([]);
      expect((await detail(newcomer.contact.id)).duplicates).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- merge

  describe('merging', () => {
    it('previews both sides with ticket counts that include hidden tickets', async () => {
      const { survivor, mergedId } = await pairWithHistory();

      const preview = await call<ContactMergePreview>(
        'GET',
        `${contactsPath()}/${survivor.id}/merge-preview?otherContactId=${mergedId}`,
        sam,
      );

      expect(preview.status).toBe(200);
      expect(preview.body.contact).toMatchObject({ id: survivor.id, ticketCount: 0 });
      // One in Support and one in Billing, which Sam cannot see.
      expect(preview.body.other).toMatchObject({ id: mergedId, ticketCount: 2 });
      expect(preview.body.identities.map((row) => row.contactId).sort()).toEqual(
        [survivor.id, mergedId].sort(),
      );
    });

    it('moves identifiers, notes and every ticket to the survivor, and undoes it', async () => {
      const { survivor, mergedId, visible, hidden, typed } = await pairWithHistory();
      await call('POST', `${contactsPath()}/${mergedId}/notes`, ada, { bodyText: 'VIP' });

      const merged = await call<ContactDetail>(
        'POST',
        `${contactsPath()}/${survivor.id}/merge`,
        sam,
        {
          mergedContactId: mergedId,
        },
      );

      expect(merged.status).toBe(201);
      expect(merged.body.name).toBe('Mona Khalil');
      // The union, each identifier as it was: the agent-typed one stays
      // unverified beside the proven one.
      expect(merged.body.identities.map((row) => [row.value, row.verified]).sort()).toEqual([
        [survivor.identities[0]?.value, false],
        [typed, true],
      ]);
      expect(merged.body.notes.map((note) => note.bodyText)).toEqual(['VIP']);
      expect(merged.body.merges).toMatchObject([{ mergedContact: { id: mergedId } }]);
      expect(await ticketContact(visible.id)).toBe(survivor.id);
      expect(await ticketContact(hidden.id)).toBe(survivor.id);

      const gone = await detail(mergedId);
      expect(gone.mergedIntoId).toBe(survivor.id);
      const listed = await call<ContactList>('GET', `${contactsPath()}?search=Mona`, ada);
      expect(listed.body.contacts.map((row) => row.id)).not.toContain(mergedId);

      const [audit] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.targetId, survivor.id), eq(auditLog.action, 'contact.merged'))),
      );
      expect(audit?.meta).toMatchObject({ mergedContactId: mergedId, ticketCount: 2 });
      expect(JSON.stringify(audit?.meta)).not.toContain('@');

      const mergeId = merged.body.merges[0]?.id ?? '';
      const undone = await call<ContactDetail>(
        'POST',
        `${contactsPath()}/${survivor.id}/merges/${mergeId}/undo`,
        sam,
      );

      expect(undone.status).toBe(201);
      expect(undone.body.merges).toEqual([]);
      expect(undone.body.identities.map((row) => row.value)).toEqual([
        survivor.identities[0]?.value,
      ]);
      expect(await ticketContact(visible.id)).toBe(mergedId);
      expect(await ticketContact(hidden.id)).toBe(mergedId);
      const restored = await detail(mergedId);
      expect(restored.mergedIntoId).toBeNull();
      expect(restored.notes).toHaveLength(1);
    });

    it('leaves a ticket the survivor gained after the merge where it is on undo', async () => {
      const { survivor, mergedId } = await pairWithHistory();
      const merged = await call<ContactDetail>(
        'POST',
        `${contactsPath()}/${survivor.id}/merge`,
        ada,
        {
          mergedContactId: mergedId,
        },
      );
      const later = await createTicket(survivor.id, support);

      await call(
        'POST',
        `${contactsPath()}/${survivor.id}/merges/${merged.body.merges[0]?.id}/undo`,
        ada,
      );

      expect(await ticketContact(later.id)).toBe(survivor.id);
    });

    it('marks the suggestion merged, and opens it again on undo', async () => {
      const value = address('suggested');
      const original = await createContact({
        name: 'Original',
        identities: [{ kind: 'email', value }],
      });
      const newcomer = await withSystem(runtime.db, seeded.brandId, (tx) =>
        findOrCreateContactByIdentity(tx, seeded.brandId, {
          kind: 'email',
          value,
          source: 'widget.form',
        }),
      );
      const suggestionId = (await detail(original.id)).duplicates[0]?.id ?? '';

      const merged = await call<ContactDetail>(
        'POST',
        `${contactsPath()}/${original.id}/merge`,
        ada,
        {
          mergedContactId: newcomer.contact.id,
          suggestionId,
        },
      );
      expect(merged.body.duplicates).toEqual([]);

      await call(
        'POST',
        `${contactsPath()}/${original.id}/merges/${merged.body.merges[0]?.id}/undo`,
        ada,
      );

      expect((await detail(original.id)).duplicates.map((row) => row.id)).toEqual([suggestionId]);
    });

    it('refuses what a merge cannot mean', async () => {
      const { survivor, mergedId } = await pairWithHistory();
      const stranger = await createContact({ name: 'Stranger' });

      const self = await call<Refusal>('POST', `${contactsPath()}/${survivor.id}/merge`, ada, {
        mergedContactId: survivor.id,
      });
      expect(self.status).toBe(400);
      expect(self.body.error.contact?.reason).toBe('merge-self');

      const viewer = await call('POST', `${contactsPath()}/${survivor.id}/merge`, vic, {
        mergedContactId: mergedId,
      });
      expect(viewer.status).toBe(403);

      const wrongSuggestion = await call('POST', `${contactsPath()}/${survivor.id}/merge`, ada, {
        mergedContactId: mergedId,
        suggestionId: uuidv7(),
      });
      expect(wrongSuggestion.status).toBe(404);

      await call('POST', `${contactsPath()}/${stranger.id}/anonymise`, ada);
      const erased = await call<Refusal>('POST', `${contactsPath()}/${survivor.id}/merge`, ada, {
        mergedContactId: stranger.id,
      });
      expect(erased.status).toBe(409);
      expect(erased.body.error.contact?.reason).toBe('anonymised');

      await call('POST', `${contactsPath()}/${survivor.id}/merge`, ada, {
        mergedContactId: mergedId,
      });
      const twice = await call<Refusal>('POST', `${contactsPath()}/${survivor.id}/merge`, ada, {
        mergedContactId: mergedId,
      });
      expect(twice.body.error.contact?.reason).toBe('merged');

      const edit = await call<Refusal>('PATCH', `${contactsPath()}/${mergedId}`, ada, {
        name: 'Edited after the merge',
      });
      expect(edit.status).toBe(409);
      expect(edit.body.error.contact?.reason).toBe('merged');
    });

    it('refuses an undo after 24 hours, a second undo, and one the contacts have outgrown', async () => {
      const first = await pairWithHistory();
      const merged = await call<ContactDetail>(
        'POST',
        `${contactsPath()}/${first.survivor.id}/merge`,
        ada,
        { mergedContactId: first.mergedId },
      );
      const mergeId = merged.body.merges[0]?.id ?? '';
      const undoPath = `${contactsPath()}/${first.survivor.id}/merges/${mergeId}/undo`;

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(contactMerges)
          .set({ undoUntil: new Date(Date.now() - 1000) })
          .where(eq(contactMerges.id, mergeId)),
      );
      const late = await call<Refusal>('POST', undoPath, ada);
      expect(late.status).toBe(409);
      expect(late.body.error.contact?.reason).toBe('merge-expired');
      // And the banner no longer offers it.
      expect((await detail(first.survivor.id)).merges).toEqual([]);

      const second = await pairWithHistory();
      const chained = await call<ContactDetail>(
        'POST',
        `${contactsPath()}/${second.survivor.id}/merge`,
        ada,
        { mergedContactId: second.mergedId },
      );
      const onward = await createContact({ name: 'Onward' });
      await call('POST', `${contactsPath()}/${onward.id}/merge`, ada, {
        mergedContactId: second.survivor.id,
      });
      const blocked = await call<Refusal>(
        'POST',
        `${contactsPath()}/${second.survivor.id}/merges/${chained.body.merges[0]?.id}/undo`,
        ada,
      );
      expect(blocked.body.error.contact?.reason).toBe('merge-blocked');

      const missing = await call(
        'POST',
        `${contactsPath()}/${onward.id}/merges/${uuidv7()}/undo`,
        ada,
      );
      expect(missing.status).toBe(404);
    });
  });
});
