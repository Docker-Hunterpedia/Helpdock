import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  attachments,
  brands,
  contacts,
  createDb,
  type Db,
  type DbHandle,
  departments,
  outbox,
  seedBrandStatuses,
  tags,
  ticketActivity,
  ticketMessages,
  ticketParticipants,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import type {
  TicketDetail,
  TicketMergeResult,
  TicketMessage,
  TicketParticipantList,
  TicketTagList,
} from '@helpdock/schemas';
import { UNMERGE_WINDOW_MS } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../../bootstrap.js';
import { createLogger } from '../../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../../seed/dev-seed.js';

/**
 * M1-09 against a real Postgres, over real sessions: DOMAIN-RULES §2.4 end to
 * end, and the isolation rules it has to keep while it moves tickets about.
 *
 * 1. **A ticket the actor cannot read answers like one that does not exist**,
 *    as the primary of a merge exactly as anywhere else (§1.2).
 * 2. **Merge**: the secondary closes as Merged with `merged_into_id`, its
 *    messages are shown inline in the primary and are not moved, tags are a
 *    union, and the secondary follows the primary's department — which is what
 *    lets a reader of the primary open the secondary's attachments.
 * 3. **Unmerge** restores the status and the department inside 24 hours and is
 *    refused after them.
 * 4. **Split** copies messages and their attachments onto a new ticket with
 *    `copied_from_message_id`, and says so in the original's thread.
 * 5. Every change writes activity and outbox rows on **both** tickets, in the
 *    request's transaction.
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
    'Skipping the M1-09 integration tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

interface Refusal {
  readonly error: { readonly code: string; readonly lifecycle?: { readonly reason: string } };
}

describe.skipIf(!hasDocker)('merge and split (DOMAIN-RULES §2.4)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;

  let support: string;
  let billing: string;
  /** Agents confined to Support and to Billing, and the install admin. */
  let sam: Person;
  let bo: Person;
  let ada: Person;
  /** Admin of a second brand, for the cross-brand refusals. */
  let ola: Person;
  let otherBrand: string;
  let otherDepartment: string;
  let mona: string;
  let yusuf: string;

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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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

  const brandPath = (brandId = seeded.brandId) => `/api/brands/${brandId}`;
  const ticketPath = (ticketId: string, brandId = seeded.brandId) =>
    `${brandPath(brandId)}/tickets/${ticketId}`;

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

  const createTicket = async (
    who: Person,
    body: Record<string, unknown>,
    brandId = seeded.brandId,
  ): Promise<TicketDetail> => {
    const response = await call<TicketDetail>('POST', `${brandPath(brandId)}/tickets`, who, {
      subject: 'Refund for order 8841',
      bodyHtml: '<p>Where is my refund?</p>',
      ...body,
    });

    expect(response.status).toBe(201);
    return response.body;
  };

  const reply = async (who: Person, ticketId: string, text: string): Promise<TicketMessage> => {
    const response = await call<TicketMessage>('POST', `${ticketPath(ticketId)}/messages`, who, {
      kind: 'note',
      bodyHtml: `<p>${text}</p>`,
    });
    expect(response.status).toBe(201);

    return response.body;
  };

  const read = async (who: Person, ticketId: string) =>
    call<TicketDetail>('GET', ticketPath(ticketId), who);

  const merge = (who: Person, secondaryId: string, primaryTicketId: string) =>
    call<TicketMergeResult & Refusal>('POST', `${ticketPath(secondaryId)}/merge`, who, {
      primaryTicketId,
    });

  const unmerge = (who: Person, secondaryId: string) =>
    call<TicketMergeResult & Refusal>('POST', `${ticketPath(secondaryId)}/unmerge`, who);

  /** A `ready` attachment on a message, as the media worker would leave one. */
  const attachReady = async (ticketId: string, messageId: string): Promise<string> =>
    withSystem(runtime.db, seeded.brandId, async (tx) => {
      const [row] = await tx
        .insert(attachments)
        .values({
          brandId: seeded.brandId,
          ticketId,
          messageId,
          departmentId: support,
          uploaderType: 'staff',
          uploaderId: ada.id,
          s3Key: `brands/${seeded.brandId}/tickets/${ticketId}/${uuidv7()}/original`,
          originalName: 'invoice-9120.pdf',
          mime: 'application/pdf',
          size: 64_000,
          kind: 'file',
          status: 'ready',
          variants: { original: { mime: 'application/pdf', size: 64_000 } },
        })
        .returning({ id: attachments.id });

      return row?.id ?? '';
    });

  const outboxFor = (ticketId: string) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.select().from(outbox).where(sql`${outbox.payload}->>'ticketId' = ${ticketId}`),
    );

  const activityFor = (ticketId: string, action: string) =>
    withSystem(runtime.db, seeded.brandId, (tx) =>
      tx
        .select()
        .from(ticketActivity)
        .where(and(eq(ticketActivity.ticketId, ticketId), eq(ticketActivity.action, action))),
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
    ola = await addPerson(db, 'ola');

    otherBrand = uuidv7();
    await db.insert(brands).values({ id: otherBrand, name: 'Globex', prefix: 'GLX' });

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
      ]);

      const people = await tx
        .insert(contacts)
        .values([
          { brandId: seeded.brandId, name: 'Mona Khalil' },
          { brandId: seeded.brandId, name: 'Yusuf Haddad' },
        ])
        .returning({ id: contacts.id, name: contacts.name });
      mona = people.find((row) => row.name === 'Mona Khalil')?.id ?? '';
      yusuf = people.find((row) => row.name === 'Yusuf Haddad')?.id ?? '';
    });

    await withSystem(db, otherBrand, async (tx) => {
      await seedBrandStatuses(tx, otherBrand);
      const [created] = await tx
        .insert(departments)
        .values({ brandId: otherBrand, name: 'General' })
        .returning({ id: departments.id });
      otherDepartment = created?.id ?? '';
      await tx
        .insert(userBrandRoles)
        .values({ userId: ola.id, brandId: otherBrand, role: 'admin', departmentIds: null });
    });

    ada.token = await signIn(seeded.email, seeded.password);
    sam.token = await signIn(sam.email, AGENT_PASSWORD);
    bo.token = await signIn(bo.email, AGENT_PASSWORD);
    ola.token = await signIn(ola.email, AGENT_PASSWORD);
  };

  // --------------------------------------------------------------- the key

  it('finds the Merged status by its key, which every brand is seeded with', async () => {
    const keys = await withSystem(runtime.db, seeded.brandId, (tx) =>
      tx.execute<{ system_key: string | null }>(
        sql`select system_key from ticket_statuses where is_system order by sort_order`,
      ),
    );

    expect(keys.map((row) => row.system_key)).toEqual([
      'open',
      'awaiting_customer',
      'escalated',
      'closed',
      'spam',
      'merged',
    ]);
  });

  // ----------------------------------------------------------------- merge

  describe('merge', () => {
    it('answers a primary in another department exactly like one that does not exist', async () => {
      const mine = await createTicket(sam, { departmentId: support });
      const theirs = await createTicket(bo, { departmentId: billing });

      const hidden = await merge(sam, mine.ticket.id, theirs.ticket.id);
      const missing = await merge(sam, mine.ticket.id, uuidv7());

      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(hidden.body.error.code).toBe(missing.body.error.code);
      expect((await read(sam, mine.ticket.id)).body.ticket.mergedIntoId).toBeNull();
    });

    it('refuses a primary of another brand as not found', async () => {
      const mine = await createTicket(ada, { departmentId: support });
      const foreign = await createTicket(ola, { departmentId: otherDepartment }, otherBrand);

      expect((await merge(ada, mine.ticket.id, foreign.ticket.id)).status).toBe(404);
      // And the other way round: a secondary the actor's brand cannot see.
      const across = await call<Refusal>('POST', `${ticketPath(foreign.ticket.id)}/merge`, ada, {
        primaryTicketId: mine.ticket.id,
      });
      expect(across.status).toBe(404);
    });

    it('closes the secondary into the primary, shows its messages inline and moves none of them', async () => {
      const secondary = await createTicket(ada, {
        departmentId: support,
        contactId: mona,
        subject: 'Invoice PDF',
      });
      const note = await reply(ada, secondary.ticket.id, 'Checked the VAT number');
      const primary = await createTicket(ada, { departmentId: billing, contactId: yusuf });

      const merged = await merge(ada, secondary.ticket.id, primary.ticket.id);

      expect(merged.status).toBe(200);
      expect(merged.body.secondary.mergedIntoId).toBe(primary.ticket.id);
      expect(merged.body.secondary.status.name).toBe('Merged');
      expect(merged.body.secondary.status.systemState).toBe('closed');
      expect(merged.body.secondary.closedAt).not.toBeNull();
      // Access follows the primary: the secondary is now filed where it is.
      expect(merged.body.secondary.departmentId).toBe(billing);

      const detail = await read(ada, primary.ticket.id);
      const block = detail.body.merged?.[0];
      expect(block?.id).toBe(secondary.ticket.id);
      expect(block?.mergedById).toBe(ada.id);
      expect(block?.unmergeableUntil).not.toBeNull();
      expect(block?.messages.map((message) => message.id)).toContain(note.id);
      // Not moved: the message is still on the secondary.
      expect(block?.messages.every((message) => message.ticketId === secondary.ticket.id)).toBe(
        true,
      );

      const announcement = detail.body.messages.messages.find(
        (message) => message.id === block?.systemMessageId,
      );
      expect(announcement?.kind).toBe('system');
      expect(announcement?.bodyText).toBe(
        `${secondary.ticket.prefix}-${secondary.ticket.number} was merged into this ticket`,
      );

      const other = await read(ada, secondary.ticket.id);
      expect(other.body.mergedInto?.id).toBe(primary.ticket.id);
    });

    it('lets a reader of the primary open the secondary and its attachments, and nobody else', async () => {
      const secondary = await createTicket(sam, { departmentId: support });
      const firstMessage = secondary.messages.messages[0]?.id ?? '';
      const file = await attachReady(secondary.ticket.id, firstMessage);
      const primary = await createTicket(bo, { departmentId: billing });

      expect((await merge(ada, secondary.ticket.id, primary.ticket.id)).status).toBe(200);

      const inline = await read(bo, primary.ticket.id);
      expect(inline.body.merged?.[0]?.messages[0]?.attachments.map((row) => row.id)).toEqual([
        file,
      ]);

      const download = `${ticketPath(secondary.ticket.id)}/attachments/${file}`;
      expect((await call('GET', download, bo)).status).toBe(200);
      // Sam filed it, and it has left his department with the merge.
      expect((await call('GET', download, sam)).status).toBe(404);
      expect((await read(sam, secondary.ticket.id)).status).toBe(404);
    });

    it('unions the tags onto the primary', async () => {
      const [billingTag, refundTag] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .insert(tags)
          .values([
            { brandId: seeded.brandId, name: `vat ${uuidv7()}`, color: 'info' },
            { brandId: seeded.brandId, name: `refund ${uuidv7()}`, color: 'warning' },
          ])
          .returning({ id: tags.id }),
      );
      const secondary = await createTicket(ada, {
        departmentId: support,
        tagIds: [billingTag?.id, refundTag?.id],
      });
      const primary = await createTicket(ada, { departmentId: support, tagIds: [refundTag?.id] });

      await merge(ada, secondary.ticket.id, primary.ticket.id);

      const after = await call<TicketTagList>('GET', `${ticketPath(primary.ticket.id)}/tags`, ada);
      expect(after.body.tags.map((tag) => tag.id).sort()).toEqual(
        [billingTag?.id, refundTag?.id].sort(),
      );
      expect(await activityFor(primary.ticket.id, 'ticket.tags.changed')).toHaveLength(1);
    });

    it('copies a different contact in as a CC of the primary, and unmerge takes it off again', async () => {
      const secondary = await createTicket(ada, { departmentId: support, contactId: mona });
      const primary = await createTicket(ada, { departmentId: support, contactId: yusuf });
      const participants = async () =>
        (
          await call<TicketParticipantList>(
            'GET',
            `${ticketPath(primary.ticket.id)}/participants`,
            ada,
          )
        ).body;

      await merge(ada, secondary.ticket.id, primary.ticket.id);

      // M1-13's participants through M1-09's seam (DOMAIN-RULES §2.4).
      expect((await participants()).ccs).toMatchObject([{ contactId: mona, source: 'merge' }]);

      await unmerge(ada, secondary.ticket.id);

      expect((await participants()).ccs).toEqual([]);
    });

    it('keeps a CC an agent added by hand when the merge that also brought it is undone', async () => {
      const secondary = await createTicket(ada, { departmentId: support, contactId: mona });
      const primary = await createTicket(ada, { departmentId: support, contactId: yusuf });
      // Copied in by hand before the merge: the row the merge's insert meets.
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.insert(ticketParticipants).values({
          brandId: seeded.brandId,
          ticketId: primary.ticket.id,
          departmentId: support,
          contactId: mona,
          source: 'agent',
        }),
      );

      await merge(ada, secondary.ticket.id, primary.ticket.id);
      await unmerge(ada, secondary.ticket.id);

      const after = await call<TicketParticipantList>(
        'GET',
        `${ticketPath(primary.ticket.id)}/participants`,
        ada,
      );
      expect(after.body.ccs).toMatchObject([{ contactId: mona, source: 'agent' }]);
    });

    it('writes activity and outbox rows on both tickets', async () => {
      const secondary = await createTicket(ada, { departmentId: support });
      const primary = await createTicket(ada, { departmentId: support });

      await merge(ada, secondary.ticket.id, primary.ticket.id);

      for (const ticketId of [secondary.ticket.id, primary.ticket.id]) {
        const [row] = await activityFor(ticketId, 'ticket.merged');
        expect(row?.from).toMatchObject({ ticketId: secondary.ticket.id });
        expect(row?.to).toMatchObject({ ticketId: primary.ticket.id });

        const events = (await outboxFor(ticketId)).map((entry) => entry.event);
        expect(events).toContain('ticket.updated');
      }
    });

    it('refuses what §2.4 has no row for, with a code the screen can read', async () => {
      const a = await createTicket(ada, { departmentId: support });
      const b = await createTicket(ada, { departmentId: support });
      const c = await createTicket(ada, { departmentId: support });

      const self = await merge(ada, a.ticket.id, a.ticket.id);
      expect(self.status).toBe(409);
      expect(self.body.error.lifecycle?.reason).toBe('merge-into-self');

      await merge(ada, a.ticket.id, b.ticket.id);

      const twice = await merge(ada, a.ticket.id, c.ticket.id);
      expect(twice.body.error.lifecycle?.reason).toBe('ticket-merged');

      const intoMerged = await merge(ada, c.ticket.id, a.ticket.id);
      expect(intoMerged.body.error.lifecycle?.reason).toBe('merge-into-merged');

      // The secondary's state belongs to the primary, and so does its department.
      const moved = await call<Refusal>('PATCH', ticketPath(a.ticket.id), ada, {
        departmentId: billing,
      });
      expect(moved.status).toBe(409);
      expect(moved.body.error.lifecycle?.reason).toBe('ticket-merged');
    });

    it('takes every merged ticket along when the primary moves, down a chain', async () => {
      const first = await createTicket(ada, { departmentId: support });
      const second = await createTicket(ada, { departmentId: support });
      const primary = await createTicket(ada, { departmentId: support });

      await merge(ada, first.ticket.id, second.ticket.id);
      await merge(ada, second.ticket.id, primary.ticket.id);

      const chain = await read(ada, primary.ticket.id);
      expect(chain.body.merged?.map((ticket) => [ticket.id, ticket.mergedIntoId])).toEqual([
        [second.ticket.id, primary.ticket.id],
        [first.ticket.id, second.ticket.id],
      ]);

      await call('PATCH', ticketPath(primary.ticket.id), ada, { departmentId: billing });

      const rows = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select({ department: tickets.departmentId })
          .from(tickets)
          .where(inArray(tickets.id, [first.ticket.id, second.ticket.id])),
      );
      expect(rows.map((row) => row.department)).toEqual([billing, billing]);
    });
  });

  // --------------------------------------------------------------- unmerge

  describe('unmerge', () => {
    it('restores the status and the department, and says so in the primary', async () => {
      const secondary = await createTicket(ada, { departmentId: support });
      const primary = await createTicket(ada, { departmentId: billing });
      await merge(ada, secondary.ticket.id, primary.ticket.id);

      const undone = await unmerge(ada, secondary.ticket.id);

      expect(undone.status).toBe(200);
      expect(undone.body.secondary.mergedIntoId).toBeNull();
      expect(undone.body.secondary.status.id).toBe(secondary.ticket.status.id);
      expect(undone.body.secondary.closedAt).toBeNull();
      expect(undone.body.secondary.departmentId).toBe(support);

      const detail = await read(ada, primary.ticket.id);
      expect(detail.body.merged).toEqual([]);
      expect(detail.body.messages.messages.at(-1)?.bodyText).toContain('was unmerged');

      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(tickets).where(eq(tickets.id, secondary.ticket.id)),
      );
      expect(row?.mergedAt).toBeNull();
      expect(row?.mergedMs).toBeGreaterThanOrEqual(0);
      expect(await activityFor(secondary.ticket.id, 'ticket.unmerged')).toHaveLength(1);
      expect(await activityFor(primary.ticket.id, 'ticket.unmerged')).toHaveLength(1);
    });

    it('lets an agent of the primary undo a merge into a department they cannot see', async () => {
      const secondary = await createTicket(sam, { departmentId: support });
      const primary = await createTicket(bo, { departmentId: billing });
      await merge(ada, secondary.ticket.id, primary.ticket.id);

      const undone = await unmerge(bo, secondary.ticket.id);

      expect(undone.status).toBe(200);
      // Back in Support, which is escalation as §1.2 allows it: gone from Bo's view.
      expect((await read(bo, secondary.ticket.id)).status).toBe(404);
      expect((await read(sam, secondary.ticket.id)).status).toBe(200);
    });

    it('is refused after 24 hours, and for a ticket that is not merged', async () => {
      const secondary = await createTicket(ada, { departmentId: support });
      const primary = await createTicket(ada, { departmentId: support });
      await merge(ada, secondary.ticket.id, primary.ticket.id);

      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .update(tickets)
          .set({ mergedAt: new Date(Date.now() - UNMERGE_WINDOW_MS - 1_000) })
          .where(eq(tickets.id, secondary.ticket.id)),
      );

      const late = await unmerge(ada, secondary.ticket.id);
      expect(late.status).toBe(409);
      expect(late.body.error.lifecycle?.reason).toBe('merge-window-closed');
      expect((await read(ada, primary.ticket.id)).body.merged?.[0]?.unmergeableUntil).toBeNull();

      const never = await unmerge(ada, primary.ticket.id);
      expect(never.body.error.lifecycle?.reason).toBe('ticket-not-merged');
    });
  });

  // ----------------------------------------------------------------- split

  describe('split', () => {
    const split = (who: Person, ticketId: string, body: Record<string, unknown>) =>
      call<TicketDetail & Refusal>('POST', `${ticketPath(ticketId)}/split`, who, body);

    it('copies the chosen messages and their attachments onto a new ticket', async () => {
      const original = await createTicket(sam, { departmentId: support, contactId: mona });
      const first = original.messages.messages[0]?.id ?? '';
      const second = await reply(sam, original.ticket.id, 'Also my invoice shows the wrong VAT');
      const file = await attachReady(original.ticket.id, second.id);

      const created = await split(sam, original.ticket.id, {
        messageIds: [second.id],
        subject: 'Invoice PDF shows wrong VAT number',
        departmentId: support,
      });

      expect(created.status).toBe(201);
      const ticket = created.body.ticket;
      expect(ticket.splitFromId).toBe(original.ticket.id);
      expect(ticket.contactId).toBe(mona);
      expect(ticket.number).toBeGreaterThan(original.ticket.number);
      expect(ticket.priority).toBe(original.ticket.priority);

      const [copy, splitFrom] = created.body.messages.messages;
      expect(copy?.bodyText).toBe(second.bodyText);
      expect(copy?.createdAt).toBe(second.createdAt);
      expect(copy?.attachments.map((row) => row.originalName)).toEqual(['invoice-9120.pdf']);
      expect(splitFrom?.kind).toBe('system');
      expect(created.body.related?.map((link) => link.id)).toEqual([original.ticket.id]);

      const [stored] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx
          .select()
          .from(ticketMessages)
          .where(eq(ticketMessages.id, copy?.id ?? '')),
      );
      expect(stored?.copiedFromMessageId).toBe(second.id);

      // The copy shares the object and is authorised through the new ticket.
      const copied = copy?.attachments[0]?.id ?? '';
      const [row] = await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.select().from(attachments).where(eq(attachments.id, copied)),
      );
      expect(row?.copiedFromAttachmentId).toBe(file);
      const download = await call<{ url: string }>(
        'GET',
        `${ticketPath(ticket.id)}/attachments/${copied}`,
        sam,
      );
      expect(download.status).toBe(200);
      // Signed for the original's object, which is the only one there is.
      expect(download.body.url).toContain(row?.s3Key ?? 'missing');

      // The original keeps every message and says where the copies went.
      const after = await read(sam, original.ticket.id);
      const ids = after.body.messages.messages.map((message) => message.id);
      expect(ids).toEqual(expect.arrayContaining([first, second.id]));
      expect(after.body.messages.messages.at(-1)?.bodyText).toBe(
        `Messages split to ${ticket.prefix}-${ticket.number}`,
      );
      expect(after.body.related?.map((link) => link.id)).toEqual([ticket.id]);

      expect(await activityFor(original.ticket.id, 'ticket.split')).toHaveLength(1);
      expect((await outboxFor(ticket.id)).map((entry) => entry.event)).toContain('ticket.created');
      expect((await outboxFor(original.ticket.id)).map((entry) => entry.event)).toContain(
        'ticket.updated',
      );
    });

    it('refuses a department the actor may not file in, and messages that are not this ticket’s', async () => {
      const original = await createTicket(sam, { departmentId: support });
      const elsewhere = await createTicket(sam, { departmentId: support });
      const message = original.messages.messages[0]?.id ?? '';

      const outside = await split(sam, original.ticket.id, {
        messageIds: [message],
        subject: 'Elsewhere',
        departmentId: billing,
      });
      expect(outside.status).toBe(403);

      const foreign = await split(sam, original.ticket.id, {
        messageIds: [elsewhere.messages.messages[0]?.id],
        subject: 'Not mine',
        departmentId: support,
      });
      expect(foreign.status).toBe(404);
    });

    it('refuses a system message, and one whose attachment is still processing', async () => {
      const original = await createTicket(ada, { departmentId: support });
      const other = await createTicket(ada, { departmentId: support });
      await merge(ada, other.ticket.id, original.ticket.id);

      const detail = await read(ada, original.ticket.id);
      const system = detail.body.messages.messages.find((message) => message.kind === 'system');
      const refusedSystem = await split(ada, original.ticket.id, {
        messageIds: [system?.id],
        subject: 'A system line',
        departmentId: support,
      });
      expect(refusedSystem.status).toBe(400);

      const busy = await reply(ada, original.ticket.id, 'A photo');
      const file = await attachReady(original.ticket.id, busy.id);
      await withSystem(runtime.db, seeded.brandId, (tx) =>
        tx.update(attachments).set({ status: 'processing' }).where(eq(attachments.id, file)),
      );

      const inFlight = await split(ada, original.ticket.id, {
        messageIds: [busy.id],
        subject: 'A photo',
        departmentId: support,
      });
      expect(inFlight.status).toBe(409);
      expect(inFlight.body.error.lifecycle?.reason).toBe('attachments-in-flight');
    });
  });

  // ------------------------------------------------------------- isolation

  describe('isolation (DOMAIN-RULES §1.6)', () => {
    it('keeps a merged ticket invisible to another brand, in SQL', async () => {
      const secondary = await createTicket(ada, { departmentId: support });
      const primary = await createTicket(ada, { departmentId: support });
      await merge(ada, secondary.ticket.id, primary.ticket.id);

      const seen = await withTenant(
        runtime.db,
        {
          brandIds: [otherBrand],
          departmentIds: 'all',
          principalType: 'staff',
          principalId: ola.id,
        },
        (tx) =>
          tx
            .select({ id: tickets.id })
            .from(tickets)
            .where(inArray(tickets.id, [secondary.ticket.id, primary.ticket.id])),
      );

      expect(seen).toEqual([]);
    });
  });
});
