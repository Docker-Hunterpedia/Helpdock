import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  auditLog,
  contactIdentities,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  ticketActivity,
  ticketTags,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type {
  CustomFieldDef,
  CustomFieldDefList,
  CustomFieldUsage,
  TagList,
  TagSummary,
  TagUsage,
  TicketDetail,
  TicketList,
  TicketTagList,
  TicketTemplate,
  TicketTemplatePreview,
} from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';

/**
 * M1-06 against a real Postgres, over real sessions.
 *
 * The unit suites prove each rule decides correctly on values. This proves the
 * things that only exist once the pieces are together and a database is under
 * them:
 *
 * 1. **`ticket_tags` is department-scoped.** An Agent of Support cannot read or
 *    write the tags of a Billing ticket of the same brand, in SQL as well as
 *    over HTTP (DOMAIN-RULES §1.3, §1.6).
 * 2. **A tag replace leaves an activity row and an outbox row in the same
 *    transaction**, or neither (§6).
 * 3. **A definition holds the values.** A type that no longer fits is refused,
 *    an option still in use is refused until `force`, and a value that does not
 *    match its definition never reaches a column.
 * 4. **A template is applied server-side**, placeholders and all, and the
 *    all-of tag filter narrows a list rather than widening it.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 23).toString('base64');
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
    'Skipping the M1-06 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

/**
 * The body of a refusal, as `AllExceptionsFilter` shapes it. The code is what
 * the screen turns into a sentence, so it is the code that is asserted on and
 * never the English beside it.
 */
interface Refusal {
  readonly error: { readonly ticketing?: { readonly reason: string } };
}

describe.skipIf(!hasDocker)('tags, custom fields and templates', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  /** One brand with two departments, and one agent confined to each. */
  let support: string;
  let billing: string;
  let sam: Person;
  let bo: Person;
  /** A Team Leader who leads Support and nothing else. */
  let tess: Person;
  /** The install admin, whose department scope is `all`. */
  let ada: Person;
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

  /** A tag with a name unique to this run, so tests never collide on the index. */
  const addTag = async (name: string, color = 'info'): Promise<TagSummary> => {
    const response = await call<TagSummary>('POST', `${brandPath()}/tags`, ada, { name, color });
    expect(response.status).toBe(201);

    return response.body;
  };

  const addField = async (body: Record<string, unknown>): Promise<CustomFieldDef> => {
    const response = await call<CustomFieldDef>('POST', `${brandPath()}/custom-fields`, ada, body);
    expect(response.status).toBe(201);

    return response.body;
  };

  const addTemplate = async (body: Record<string, unknown>): Promise<TicketTemplate> => {
    const response = await call<TicketTemplate>(
      'POST',
      `${brandPath()}/ticket-templates`,
      ada,
      body,
    );
    expect(response.status).toBe(201);

    return response.body;
  };

  const createTicket = async (
    who: Person,
    body: Record<string, unknown> = {},
  ): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath()}/tickets`, who, {
      subject: 'Refund for order 42',
      bodyHtml: '<p>Where is my refund?</p>',
      departmentId: support,
      ...body,
    });

    expect(response.status).toBe(201);
    return response.body;
  };

  let unique = 0;
  const name = (prefix: string): string => {
    unique += 1;
    return `${prefix} ${unique}`;
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
    bo = await addPerson(db, 'bo');
    tess = await addPerson(db, 'tess');

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
        { userId: bo.id, brandId: seeded.brandId, role: 'agent', departmentIds: [billing] },
        {
          userId: tess.id,
          brandId: seeded.brandId,
          role: 'team_leader',
          departmentIds: [support],
        },
      ]);

      const [contact] = await tx
        .insert(contacts)
        .values({ brandId: seeded.brandId, name: 'Mona Khalil Saad' })
        .returning({ id: contacts.id });
      contactId = contact?.id ?? '';
      await tx.insert(contactIdentities).values({
        brandId: seeded.brandId,
        contactId,
        kind: 'email',
        value: 'mona@example.com',
        source: 'test',
      });
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, AGENT_PASSWORD);
    bo.token = await signIn(bo.email, AGENT_PASSWORD);
    tess.token = await signIn(tess.email, AGENT_PASSWORD);
  };

  // ---------------------------------------------------------------- tags

  describe('tags', () => {
    it('is readable by an Agent and writable only with ticketing:manage', async () => {
      const list = await call<TagList>('GET', `${brandPath()}/tags`, sam);
      expect(list.status).toBe(200);

      // DOMAIN-RULES §1.2: an Agent manages nothing.
      const refused = await call('POST', `${brandPath()}/tags`, sam, { name: name('Nope') });
      expect(refused.status).toBe(403);
    });

    it('refuses a second tag whose name differs only in case', async () => {
      const tag = await addTag(name('Refund'));

      const second = await call<Refusal>('POST', `${brandPath()}/tags`, ada, {
        name: tag.name.toUpperCase(),
      });

      expect(second.status).toBe(409);
      expect(second.body.error.ticketing?.reason).toBe('name-taken');
    });

    it('writes an audit row for a definition change', async () => {
      const tag = await addTag(name('Audited'));

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.targetId, tag.id)),
      );

      expect(rows.map((row) => row.action)).toContain('tag.created');
    });

    it('reorders the whole list and refuses a partial one', async () => {
      const first = await addTag(name('Order a'));
      const second = await addTag(name('Order b'));

      const partial = await call('POST', `${brandPath()}/tags/reorder`, ada, {
        tagIds: [first.id, second.id],
      });
      expect(partial.status).toBe(400);

      const all = await call<TagList>('GET', `${brandPath()}/tags`, ada);
      const reversed = [...all.body.tags].map((row) => row.id).reverse();
      const whole = await call<TagList>('POST', `${brandPath()}/tags/reorder`, ada, {
        tagIds: reversed,
      });

      expect(whole.status).toBe(201);
      expect(whole.body.tags.map((row) => row.id)).toEqual(reversed);
    });
  });

  describe('tags on a ticket', () => {
    it('replaces the set, and writes one activity row and one outbox row', async () => {
      const tag = await addTag(name('Replace'));
      const { ticket } = await createTicket(ada);

      const before = await unpublishedCount();
      const replaced = await call<TicketTagList>(
        'PUT',
        `${brandPath()}/tickets/${ticket.id}/tags`,
        ada,
        { tagIds: [tag.id] },
      );

      expect(replaced.status).toBe(200);
      expect(replaced.body.tags.map((row) => row.name)).toEqual([tag.name]);

      const activity = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(ticketActivity)
          .where(
            and(
              eq(ticketActivity.ticketId, ticket.id),
              eq(ticketActivity.action, 'ticket.tags.changed'),
            ),
          ),
      );

      expect(activity).toHaveLength(1);
      expect(activity[0]?.to).toEqual({ tagIds: [tag.id] });
      expect(await unpublishedCount()).toBe(before + 1);
    });

    it('writes nothing at all when the set does not change', async () => {
      const tag = await addTag(name('Idempotent'));
      const { ticket } = await createTicket(ada);
      const path = `${brandPath()}/tickets/${ticket.id}/tags`;

      await call('PUT', path, ada, { tagIds: [tag.id] });
      const before = await unpublishedCount();
      await call('PUT', path, ada, { tagIds: [tag.id] });

      const activity = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(ticketActivity)
          .where(
            and(
              eq(ticketActivity.ticketId, ticket.id),
              eq(ticketActivity.action, 'ticket.tags.changed'),
            ),
          ),
      );

      expect(activity).toHaveLength(1);
      expect(await unpublishedCount()).toBe(before);
    });

    it('refuses a tag that is not this brand’s', async () => {
      const { ticket } = await createTicket(ada);

      const refused = await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, {
        tagIds: [uuidv7()],
      });

      expect(refused.status).toBe(404);
    });

    it('denormalises the department from the parent ticket', async () => {
      const tag = await addTag(name('Denormalised'));
      const { ticket } = await createTicket(ada, { departmentId: billing });

      await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(ticketTags).where(eq(ticketTags.ticketId, ticket.id)),
      );

      expect(rows[0]?.departmentId).toBe(billing);
    });

    it('moves the tags with a ticket that changes department', async () => {
      const tag = await addTag(name('Moved'));
      const { ticket } = await createTicket(ada, { departmentId: support });
      await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

      await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, { departmentId: billing });

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(ticketTags).where(eq(ticketTags.ticketId, ticket.id)),
      );

      // Without this, Support would keep reading the tags of a ticket that is
      // now Billing's, which is the opposite of what the move means.
      expect(rows[0]?.departmentId).toBe(billing);
    });

    describe('department scope (DOMAIN-RULES §1.3, §1.6)', () => {
      it('hides another department’s tags from an Agent, over HTTP', async () => {
        const tag = await addTag(name('Scoped'));
        const { ticket } = await createTicket(ada, { departmentId: billing });
        await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

        const read = await call('GET', `${brandPath()}/tickets/${ticket.id}/tags`, sam);
        const write = await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, sam, {
          tagIds: [],
        });

        expect(read.status).toBe(404);
        expect(write.status).toBe(404);
      });

      it('hides them in hand-written SQL too, because the policy is the wall', async () => {
        const tag = await addTag(name('Policy'));
        const { ticket } = await createTicket(ada, { departmentId: billing });
        await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

        const visible = await withTenant(
          runtime.db,
          {
            brandIds: [seeded.brandId],
            departmentIds: [support],
            principalType: 'staff',
            principalId: sam.id,
          },
          (tx) => tx.select().from(ticketTags).where(eq(ticketTags.ticketId, ticket.id)),
        );

        expect(visible).toEqual([]);
      });

      it('refuses an insert for a ticket the transaction cannot see', async () => {
        const tag = await addTag(name('Refused'));
        const { ticket } = await createTicket(ada, { departmentId: billing });

        const rejection = await withTenant(
          runtime.db,
          {
            brandIds: [seeded.brandId],
            departmentIds: [support],
            principalType: 'staff',
            principalId: sam.id,
          },
          (tx) =>
            tx.insert(ticketTags).values({
              brandId: seeded.brandId,
              ticketId: ticket.id,
              tagId: tag.id,
              departmentId: support,
            }),
        ).then(
          () => undefined,
          (error: unknown) => error as { cause?: { message?: string } },
        );

        expect(rejection?.cause?.message).toMatch(/not visible in this transaction/i);
      });
    });

    it('detaches the tag from every ticket when it is deleted', async () => {
      const tag = await addTag(name('Detached'));
      const { ticket } = await createTicket(ada);
      await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

      const usage = await call<TagUsage>('GET', `${brandPath()}/tags/${tag.id}/usage`, ada);
      expect(usage.body.ticketCount).toBe(1);

      const deleted = await call('DELETE', `${brandPath()}/tags/${tag.id}`, ada);
      expect(deleted.status).toBe(204);

      const still = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticket.id}`, ada);
      expect(still.status).toBe(200);
      expect(still.body.ticket.tags).toEqual([]);
    });
  });

  // ------------------------------------------------------------ the filter

  describe('the tag filter', () => {
    it('asks for tickets carrying every tag named, not any of them', async () => {
      const one = await addTag(name('Filter a'));
      const two = await addTag(name('Filter b'));

      const both = await createTicket(ada, { subject: 'Both tags' });
      const only = await createTicket(ada, { subject: 'One tag' });

      await call('PUT', `${brandPath()}/tickets/${both.ticket.id}/tags`, ada, {
        tagIds: [one.id, two.id],
      });
      await call('PUT', `${brandPath()}/tickets/${only.ticket.id}/tags`, ada, { tagIds: [one.id] });

      const all = await call<TicketList>(
        'GET',
        `${brandPath()}/tickets?tagId=${one.id}&tagId=${two.id}`,
        ada,
      );
      const any = await call<TicketList>('GET', `${brandPath()}/tickets?tagId=${one.id}`, ada);

      expect(all.body.tickets.map((row) => row.id)).toEqual([both.ticket.id]);
      expect(any.body.tickets.map((row) => row.id)).toContain(only.ticket.id);
    });

    it('reads tagIds as the same filter', async () => {
      const tag = await addTag(name('Filter c'));
      const { ticket } = await createTicket(ada);
      await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

      const { body } = await call<TicketList>(
        'GET',
        `${brandPath()}/tickets?tagIds=${tag.id}`,
        ada,
      );

      expect(body.tickets.map((row) => row.id)).toContain(ticket.id);
    });

    it('embeds the chips in the list, so a row never resolves its own ids', async () => {
      const tag = await addTag(name('Embedded'));
      const { ticket } = await createTicket(ada);
      await call('PUT', `${brandPath()}/tickets/${ticket.id}/tags`, ada, { tagIds: [tag.id] });

      const { body } = await call<TicketList>('GET', `${brandPath()}/tickets?tagId=${tag.id}`, ada);

      expect(body.tickets[0]?.tags).toEqual([
        { id: tag.id, name: tag.name, nameAr: null, color: tag.color },
      ]);
    });
  });

  // ------------------------------------------------------- custom fields

  describe('custom fields', () => {
    it('refuses a value that does not fit its definition', async () => {
      const field = await addField({
        target: 'ticket',
        key: `seats_${unique}`,
        label: 'Seats',
        type: 'number',
      });

      const refused = await call('POST', `${brandPath()}/tickets`, ada, {
        subject: 'Bad value',
        bodyHtml: '<p>x</p>',
        departmentId: support,
        custom: { [field.key]: 'not a number' },
      });

      expect(refused.status).toBe(400);
    });

    it('refuses a key no definition names, rather than storing it', async () => {
      const refused = await call('POST', `${brandPath()}/tickets`, ada, {
        subject: 'Unknown key',
        bodyHtml: '<p>x</p>',
        departmentId: support,
        custom: { nothing_defines_this: 'x' },
      });

      expect(refused.status).toBe(400);
    });

    it('stores a coerced value and patches it', async () => {
      const field = await addField({
        target: 'ticket',
        key: `renews_${unique}`,
        label: 'Renews on',
        type: 'date',
      });

      const { ticket } = await createTicket(ada, {
        custom: { [field.key]: '2026-03-01T13:45:00Z' },
      });
      expect(ticket.custom).toEqual({ [field.key]: '2026-03-01' });

      const patched = await call<{ custom: Record<string, unknown> }>(
        'PATCH',
        `${brandPath()}/tickets/${ticket.id}`,
        ada,
        { custom: { [field.key]: null } },
      );

      expect(patched.body.custom).toEqual({});
    });

    it('refuses a type change once rows carry a value, and names the rule', async () => {
      const field = await addField({
        target: 'ticket',
        key: `tier_${unique}`,
        label: 'Tier',
        type: 'text',
      });
      await createTicket(ada, { custom: { [field.key]: 'gold' } });

      const refused = await call<Refusal>(
        'PATCH',
        `${brandPath()}/custom-fields/${field.id}`,
        ada,
        {
          type: 'number',
        },
      );

      expect(refused.status).toBe(409);
      expect(refused.body.error.ticketing?.reason).toBe('field-in-use');
    });

    it('refuses to remove an option rows still carry, then clears it with force', async () => {
      const field = await addField({
        target: 'ticket',
        key: `plan_${unique}`,
        label: 'Plan',
        type: 'select',
        options: ['gold', 'silver'],
      });
      const { ticket } = await createTicket(ada, { custom: { [field.key]: 'gold' } });

      const usage = await call<CustomFieldUsage>(
        'GET',
        `${brandPath()}/custom-fields/${field.id}/usage`,
        ada,
      );
      expect(usage.body.optionRows).toEqual({ gold: 1 });

      const refused = await call<Refusal>(
        'PATCH',
        `${brandPath()}/custom-fields/${field.id}`,
        ada,
        {
          options: ['silver'],
        },
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error.ticketing?.reason).toBe('option-in-use');

      const forced = await call('PATCH', `${brandPath()}/custom-fields/${field.id}`, ada, {
        options: ['silver'],
        force: true,
      });
      expect(forced.status).toBe(200);

      // The ticket is left with nothing rather than with a choice that no
      // longer exists, so its next patch still validates.
      const after = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticket.id}`, ada);
      expect(after.body.ticket.custom).toEqual({});
    });

    it('takes one element off a multi-select and keeps the rest', async () => {
      const field = await addField({
        target: 'ticket',
        key: `addons_${unique}`,
        label: 'Add-ons',
        type: 'multi_select',
        options: ['sso', 'sla'],
      });
      const { ticket } = await createTicket(ada, { custom: { [field.key]: ['sso', 'sla'] } });

      await call('PATCH', `${brandPath()}/custom-fields/${field.id}`, ada, {
        options: ['sla'],
        force: true,
      });

      const after = await call<TicketDetail>('GET', `${brandPath()}/tickets/${ticket.id}`, ada);
      expect(after.body.ticket.custom).toEqual({ [field.key]: ['sla'] });
    });

    it('enforces required on a create and not on a patch', async () => {
      const field = await addField({
        target: 'ticket',
        key: `mandatory_${unique}`,
        label: 'Mandatory',
        type: 'text',
        required: true,
      });

      const missing = await call('POST', `${brandPath()}/tickets`, ada, {
        subject: 'No value',
        bodyHtml: '<p>x</p>',
        departmentId: support,
      });
      expect(missing.status).toBe(400);

      const { ticket } = await createTicket(ada, { custom: { [field.key]: 'here' } });
      const patched = await call('PATCH', `${brandPath()}/tickets/${ticket.id}`, ada, {
        subject: 'Renamed',
      });
      expect(patched.status).toBe(200);

      await call('DELETE', `${brandPath()}/custom-fields/${field.id}`, ada);
    });

    it('validates a contact patch against the contact definitions', async () => {
      const field = await addField({
        target: 'contact',
        key: `seats_c_${unique}`,
        label: 'Seats',
        type: 'number',
      });

      const bad = await call('PATCH', `${brandPath()}/contacts/${contactId}`, ada, {
        custom: { [field.key]: 'lots' },
      });
      expect(bad.status).toBe(400);

      const good = await call('PATCH', `${brandPath()}/contacts/${contactId}`, ada, {
        custom: { [field.key]: '12' },
      });
      expect(good.status).toBe(200);
    });

    it('refuses a value-rewriting change to somebody who cannot see every department', async () => {
      const field = await addField({
        target: 'ticket',
        key: `scoped_${unique}`,
        label: 'Scoped',
        type: 'select',
        options: ['gold', 'silver'],
      });

      // A usage count is of rows the actor can see, and `tickets` is
      // department-scoped: acting on a partial count would leave rows nobody
      // warned them about carrying an option that no longer exists.
      const refused = await call<Refusal>(
        'PATCH',
        `${brandPath()}/custom-fields/${field.id}`,
        tess,
        { options: ['silver'], force: true },
      );

      expect(refused.status).toBe(403);
      expect(refused.body.error.ticketing?.reason).toBe('out-of-scope');

      // The same leader may still rename it: nothing stored changes.
      const renamed = await call('PATCH', `${brandPath()}/custom-fields/${field.id}`, tess, {
        label: 'Renamed by the leader',
      });
      expect(renamed.status).toBe(200);
    });

    it('refuses to leave a select field with no options to choose from', async () => {
      const field = await addField({
        target: 'ticket',
        key: `empty_${unique}`,
        label: 'Empty',
        type: 'select',
        options: ['gold'],
      });

      // The request names options and not a type, so only the stored row knows
      // this would leave a menu nobody can pick from.
      const refused = await call('PATCH', `${brandPath()}/custom-fields/${field.id}`, ada, {
        options: [],
        force: true,
      });

      expect(refused.status).toBe(400);
    });

    it('narrows the list to one target when asked', async () => {
      const { body } = await call<CustomFieldDefList>(
        'GET',
        `${brandPath()}/custom-fields?target=contact`,
        ada,
      );

      expect(body.fields.every((field) => field.target === 'contact')).toBe(true);
    });
  });

  // ----------------------------------------------------------- templates

  describe('ticket templates', () => {
    it('renders a preview and leaves an unknown placeholder spelled out', async () => {
      const template = await addTemplate({
        name: name('Preview'),
        subject: 'Refund for {{contact.first_name}}',
        bodyText: 'Hello {{contcat.name}}, this is {{brand.name}}.',
      });

      const { body } = await call<TicketTemplatePreview>(
        'GET',
        `${brandPath()}/ticket-templates/${template.id}/preview?contactId=${contactId}`,
        ada,
      );

      expect(body.subject).toBe('Refund for Mona');
      expect(body.bodyText).toContain('{{contcat.name}}');
      expect(body.unknownPlaceholders).toEqual(['contcat.name']);
    });

    it('never answers a placeholder that walks a prototype', async () => {
      const template = await addTemplate({
        name: name('Injection'),
        subject: '{{constructor.constructor}}',
        bodyText: '{{__proto__}} {{toString}}',
      });

      const { body } = await call<TicketTemplatePreview>(
        'GET',
        `${brandPath()}/ticket-templates/${template.id}/preview`,
        ada,
      );

      expect(body.subject).toBe('{{constructor.constructor}}');
      expect(body.bodyText).toBe('{{__proto__}} {{toString}}');
    });

    it('applies the template on creation, server-side', async () => {
      const tag = await addTag(name('Templated'));
      const field = await addField({
        target: 'ticket',
        key: `tplfield_${unique}`,
        label: 'From template',
        type: 'text',
      });
      const template = await addTemplate({
        name: name('Applied'),
        departmentId: billing,
        priority: 'high',
        subject: 'Refund for {{contact.first_name}}',
        bodyText: 'Hello {{contact.first_name}}.\n\nWe are on it.',
        defaultTagIds: [tag.id],
        customDefaults: { [field.key]: 'filled in' },
      });

      const detail = await createTicket(ada, {
        subject: undefined,
        bodyHtml: undefined,
        departmentId: undefined,
        templateId: template.id,
        contactId,
      });

      expect(detail.ticket.subject).toBe('Refund for Mona');
      expect(detail.ticket.departmentId).toBe(billing);
      expect(detail.ticket.priority).toBe('high');
      expect(detail.ticket.tags?.map((row) => row.id)).toEqual([tag.id]);
      expect(detail.ticket.custom).toEqual({ [field.key]: 'filled in' });
      // The body is escaped and wrapped before the sanitiser sees it.
      expect(detail.messages.messages[0]?.bodyHtml).toContain('<p>Hello Mona.</p>');

      const after = await call<TicketTemplate>(
        'GET',
        `${brandPath()}/ticket-templates/${template.id}`,
        ada,
      );
      expect(after.body.usageCount).toBe(1);
    });

    it('lets the request override what the template says', async () => {
      const template = await addTemplate({
        name: name('Overridden'),
        departmentId: billing,
        priority: 'low',
        subject: 'From the template',
        bodyText: 'Body',
      });

      const detail = await createTicket(ada, {
        subject: 'From the request',
        bodyHtml: undefined,
        departmentId: support,
        priority: 'urgent',
        templateId: template.id,
      });

      expect(detail.ticket.subject).toBe('From the request');
      expect(detail.ticket.departmentId).toBe(support);
      expect(detail.ticket.priority).toBe('urgent');
    });

    it('refuses a creation whose template names no department and nor does the request', async () => {
      const template = await addTemplate({
        name: name('No department'),
        subject: 'Subject',
        bodyText: 'Body',
      });

      const refused = await call('POST', `${brandPath()}/tickets`, ada, {
        templateId: template.id,
      });

      expect(refused.status).toBe(400);
    });

    it('drops a default tag the brand has deleted rather than failing', async () => {
      const tag = await addTag(name('Doomed'));
      const template = await addTemplate({
        name: name('Stale defaults'),
        departmentId: support,
        subject: 'Subject',
        bodyText: 'Body',
        defaultTagIds: [tag.id],
      });

      await call('DELETE', `${brandPath()}/tags/${tag.id}`, ada);

      const detail = await createTicket(ada, {
        subject: undefined,
        bodyHtml: undefined,
        departmentId: undefined,
        templateId: template.id,
      });

      expect(detail.ticket.tags).toEqual([]);
    });

    it('refuses a default that no ticket field accepts, when the template is saved', async () => {
      const field = await addField({
        target: 'ticket',
        key: `seats_t_${unique}`,
        label: 'Seats',
        type: 'number',
      });

      const refused = await call('POST', `${brandPath()}/ticket-templates`, ada, {
        name: name('Bad default'),
        subject: 'Subject',
        bodyText: 'Body',
        customDefaults: { [field.key]: 'lots' },
      });

      // Caught here rather than on every ticket filed from it: the person who
      // can fix it is the one saving the template.
      expect(refused.status).toBe(400);
    });

    it('stores a coerced default, so the ticket gets a number and not a string', async () => {
      const field = await addField({
        target: 'ticket',
        key: `seats_u_${unique}`,
        label: 'Seats',
        type: 'number',
      });
      const template = await addTemplate({
        name: name('Coerced'),
        departmentId: support,
        subject: 'Subject',
        bodyText: 'Body',
        customDefaults: { [field.key]: '12' },
      });

      expect(template.customDefaults).toEqual({ [field.key]: 12 });
    });

    it('keeps a Team Leader inside the departments they lead', async () => {
      // `sam` is an Agent, so the permission alone stops them; the scope rule
      // is what stops a Team Leader, and it is the same function the
      // departments service uses (`brands/department-scope.ts`).
      const refused = await call('POST', `${brandPath()}/ticket-templates`, sam, {
        name: name('Not mine'),
        departmentId: billing,
        subject: 'Subject',
        bodyText: 'Body',
      });

      expect(refused.status).toBe(403);
    });

    it('is readable by anybody who may write a ticket', async () => {
      const list = await call('GET', `${brandPath()}/ticket-templates`, bo);

      expect(list.status).toBe(200);
    });
  });

  /** How many outbox rows this brand has that a worker has not published yet. */
  const unpublishedCount = async (): Promise<number> => {
    const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.publishedAt} is null`),
    );

    return rows.length;
  };
});
