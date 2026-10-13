import {
  accounts,
  attachments,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  departments,
  importExternalIds,
  importLog,
  importRecords,
  importRuns,
  outbox,
  runMigrations,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { hashImportValue } from '@helpdock/importers';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactMergesRepository } from '../../contacts/contact-merges.repository.js';
import { ContactsRepository } from '../../contacts/contacts.repository.js';
import { hasDocker, startPostgres, startRedis } from '../../testing/meta-install.js';
import { type TicketLoad, ticketLoadSchema } from './contracts.js';
import { ImportWriter } from './import-writer.js';
import { contactLoadSchema, organizationLoadSchema } from './profile-contracts.js';

const BRAND = uuidv7();
const OTHER_BRAND = uuidv7();
const USER = uuidv7();
const DEPARTMENT = uuidv7();
const OTHER_DEPARTMENT = uuidv7();
const STATUS = uuidv7();
const CONTACT = uuidv7();
const RUN = uuidv7();

function request(externalId = '42'): TicketLoad {
  return ticketLoadSchema.parse({
    brandId: BRAND,
    runId: RUN,
    source: 'zendesk',
    record: {
      externalId,
      number: '900',
      subject: 'Original ticket',
      status: 'open',
      ccEmails: [],
      tags: [],
      custom: {},
      createdAt: '2019-01-01T00:00:00Z',
      updatedAt: '2019-01-03T00:00:00Z',
    },
    resolved: {
      statusId: STATUS,
      departmentId: DEPARTMENT,
      teamId: null,
      priority: 'high',
      channel: 'email',
      assigneeId: USER,
      contactId: CONTACT,
      custom: {},
    },
    authors: {
      customer: { kind: 'contact', id: CONTACT },
      oldagent: { kind: 'name', name: 'Original agent' },
      staff: { kind: 'staff', id: USER },
    },
    messages: [
      {
        externalId: `m-${externalId}-2`,
        ticketExternalId: externalId,
        authorExternalId: 'oldagent',
        authorKind: 'agent',
        public: false,
        bodyHtml: '<p>Private note</p>',
        createdAt: '2019-01-02T00:00:00Z',
        attachments: [],
      },
      {
        externalId: `m-${externalId}-1`,
        ticketExternalId: externalId,
        authorExternalId: 'customer',
        authorKind: 'customer',
        public: true,
        bodyHtml: '<p>Hello</p><script>bad()</script><img src="https://tracker.invalid/a">',
        createdAt: '2019-01-01T00:00:00Z',
        attachments: [],
      },
    ],
  });
}

describe.skipIf(!hasDocker)('M11 direct history writer', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let owner: DbHandle;
  let app: DbHandle;
  let redis: Redis;
  const writer = new ImportWriter();

  beforeAll(async () => {
    postgres = await startPostgres();
    redisContainer = await startRedis();
    redis = new Redis(redisContainer.getConnectionUrl());
    await runMigrations({
      migrationUrl: postgres.getConnectionUri(),
      appRolePassword: 'import-tests',
      log: () => {},
    });
    owner = createDb({ url: postgres.getConnectionUri(), max: 1 });
    const runtimeUrl = new URL(postgres.getConnectionUri());
    runtimeUrl.username = 'helpdock_app';
    runtimeUrl.password = 'import-tests';
    app = createDb({ url: runtimeUrl.toString(), max: 2 });
    await owner.db
      .insert(users)
      .values({ id: USER, email: 'importer@example.com', name: 'Importer', status: 'active' });
    await owner.db.insert(brands).values([
      { id: BRAND, name: 'Import', prefix: 'IMP' },
      { id: OTHER_BRAND, name: 'Other', prefix: 'OTH' },
    ]);
    await owner.db.insert(departments).values([
      { id: DEPARTMENT, brandId: BRAND, name: 'Support' },
      { id: OTHER_DEPARTMENT, brandId: OTHER_BRAND, name: 'Other' },
    ]);
    await owner.db.insert(ticketStatuses).values({
      id: STATUS,
      brandId: BRAND,
      name: 'Open',
      systemState: 'open',
      isDefault: true,
      color: 'info',
    });
    await owner.db
      .insert(contacts)
      .values({ id: CONTACT, brandId: BRAND, name: 'Original customer' });
    await owner.db
      .insert(userBrandRoles)
      .values({ userId: USER, brandId: BRAND, role: 'agent', departmentIds: [DEPARTMENT] });
    await owner.db
      .insert(importRuns)
      .values({ id: RUN, brandId: BRAND, source: 'zendesk', status: 'loading', startedBy: USER });
  }, 300000);
  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await redis?.quit();
    await redisContainer?.stop();
    await postgres?.stop();
  });

  it('loads companies with all domains/notes, links through a secondary domain and writes nothing on repeat', async () => {
    const input = organizationLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      custom: { region: 'MENA' },
      record: {
        externalId: 'company-1',
        name: 'Original company',
        domains: ['EXAMPLE.COM', 'other.example'],
        notes: 'Original company note',
        custom: {},
      },
    });
    const first = await withSystem(app.db, BRAND, (tx) => writer.organization(tx, input));
    const [company] = await owner.db.select().from(accounts).where(eq(accounts.id, first.id));
    expect(company).toMatchObject({
      domain: 'example.com',
      custom: { region: 'MENA' },
      importedDetails: {
        domains: ['example.com', 'other.example'],
        notes: 'Original company note',
      },
    });
    const before = await owner.db.execute(
      sql`SELECT xmin::text AS revision FROM accounts WHERE id = ${first.id}`,
    );
    expect(await withSystem(app.db, BRAND, (tx) => writer.organization(tx, input))).toEqual({
      id: first.id,
      outcome: 'unchanged',
    });
    expect([
      ...(await owner.db.execute(
        sql`SELECT xmin::text AS revision FROM accounts WHERE id = ${first.id}`,
      )),
    ]).toEqual([...before]);
    input.record = {
      ...input.record,
      externalId: 'company-2',
      name: 'Other vendor label',
      domains: ['other.example'],
    };
    expect(await withSystem(app.db, BRAND, (tx) => writer.organization(tx, input))).toEqual({
      id: first.id,
      outcome: 'linked',
    });
    expect((await owner.db.select().from(accounts).where(eq(accounts.id, first.id)))[0]?.name).toBe(
      'Original company',
    );
  });

  it('creates unverified imported identifiers and retains unsupported profile values with safe warnings', async () => {
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: { tier: 'gold' },
      record: {
        externalId: 'profile-1',
        name: 'Source person',
        emails: ['PROFILE@example.com'],
        phones: ['+963931234567', 'local-only'],
        locale: 'fr',
        timezone: 'Invalid/Zone',
        custom: {},
      },
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    const [profile] = await owner.db.select().from(contacts).where(eq(contacts.id, loaded.id));
    expect(profile).toMatchObject({
      name: 'Source person',
      locale: null,
      timezone: null,
      custom: { tier: 'gold' },
      importedDetails: {
        phones: ['+963931234567', 'local-only'],
        locale: 'fr',
        timezone: 'Invalid/Zone',
      },
    });
    const identifiers = await owner.db
      .select()
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, loaded.id));
    expect(
      identifiers.map((identity) => [
        identity.kind,
        identity.value,
        identity.verified,
        identity.source,
      ]),
    ).toEqual([
      ['email', 'profile@example.com', false, 'import'],
      ['phone', '+963931234567', false, 'import'],
    ]);
    const warnings = await owner.db
      .select()
      .from(importLog)
      .where(eq(importLog.externalId, 'profile-1'));
    expect(warnings).toHaveLength(3);
    expect(JSON.stringify(warnings)).not.toMatch(/PROFILE@example|local-only|Invalid\/Zone/);
    expect(await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input))).toEqual({
      id: loaded.id,
      outcome: 'unchanged',
    });
    expect(
      await owner.db.select().from(importLog).where(eq(importLog.externalId, 'profile-1')),
    ).toHaveLength(3);
  });

  it('links a known identity without renaming the local person or downgrading verification', async () => {
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: CONTACT,
      kind: 'email',
      value: 'local@example.com',
      verified: true,
      source: 'agent',
    });
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-local',
        name: 'Vendor name',
        emails: ['LOCAL@example.com'],
        phones: [],
        custom: {},
      },
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input))).toEqual({
      id: CONTACT,
      outcome: 'linked',
    });
    expect((await owner.db.select().from(contacts).where(eq(contacts.id, CONTACT)))[0]?.name).toBe(
      'Original customer',
    );
    expect(
      (
        await owner.db
          .select()
          .from(contactIdentities)
          .where(eq(contactIdentities.contactId, CONTACT))
      )[0]?.verified,
    ).toBe(true);
  });

  it('refuses conflicting identities instead of merging contacts', async () => {
    const second = uuidv7();
    await owner.db.insert(contacts).values({ id: second, brandId: BRAND, name: 'Second' });
    await owner.db.insert(contactIdentities).values({
      brandId: BRAND,
      contactId: second,
      kind: 'email',
      value: 'second@example.com',
      verified: false,
      source: 'agent',
    });
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-conflict',
        name: 'Ambiguous',
        emails: ['local@example.com', 'second@example.com'],
        phones: [],
        custom: {},
      },
    });
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.contact(tx, input)),
    ).rejects.toMatchObject({ code: 'identity-ambiguous' });
    expect(
      await owner.db
        .select()
        .from(importExternalIds)
        .where(eq(importExternalIds.externalId, 'profile-conflict')),
    ).toHaveLength(0);
  });

  it('clears retained import profile data on erasure and refuses to resurrect the contact on another run', async () => {
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-erased',
        name: 'Erase me',
        emails: ['erased-source@example.com'],
        phones: ['local number'],
        custom: {},
      },
    });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: RUN,
      entity: 'contact',
      externalId: 'profile-erased',
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    await withSystem(app.db, BRAND, (tx) =>
      new ContactsRepository().anonymise(tx, loaded.id, { name: 'Erased contact', identities: [] }),
    );
    expect(
      (await owner.db.select().from(contacts).where(eq(contacts.id, loaded.id)))[0]
        ?.importedDetails,
    ).toBeNull();
    expect(
      await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.externalId, 'profile-erased')),
    ).toHaveLength(0);
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.contact(tx, input)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
  });

  it('follows a manual contact merge without rewriting the stable source identity', async () => {
    const input = contactLoadSchema.parse({
      brandId: BRAND,
      runId: RUN,
      source: 'zendesk',
      accountId: null,
      custom: {},
      record: {
        externalId: 'profile-merged',
        name: 'Source identity',
        emails: ['merged-source@example.com'],
        phones: [],
        custom: {},
      },
    });
    const original = await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input));
    const survivor = uuidv7();
    await owner.db
      .insert(contacts)
      .values({ id: survivor, brandId: BRAND, name: 'Manual survivor' });
    await withSystem(app.db, BRAND, async (tx) => {
      const merges = new ContactMergesRepository();
      await merges.moveIdentities(tx, { from: original.id, to: survivor });
      await merges.markMerged(tx, original.id, survivor);
    });
    expect(await withSystem(app.db, BRAND, (tx) => writer.contact(tx, input))).toEqual({
      id: survivor,
      outcome: 'unchanged',
    });
    expect(
      (
        await owner.db
          .select()
          .from(importExternalIds)
          .where(eq(importExternalIds.externalId, 'profile-merged'))
      )[0]?.helpdockId,
    ).toBe(original.id);
    await owner.db.insert(importRecords).values({
      brandId: BRAND,
      runId: RUN,
      entity: 'contact',
      externalId: input.record.externalId,
      payload: input.record,
      payloadHash: hashImportValue(input.record),
    });
    await withSystem(app.db, BRAND, (tx) =>
      new ContactsRepository().anonymise(tx, survivor, { name: 'Erased contact', identities: [] }),
    );
    expect(
      (await owner.db.select().from(contacts).where(eq(contacts.id, original.id)))[0]
        ?.importedDetails,
    ).toBeNull();
    expect(
      await owner.db
        .select()
        .from(importRecords)
        .where(eq(importRecords.externalId, input.record.externalId)),
    ).toHaveLength(0);
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.contact(tx, input)),
    ).rejects.toMatchObject({ code: 'target-unavailable' });
  });

  it('retains historical assignees mapped to invited staff without activating them or sending mail', async () => {
    const invited = uuidv7();
    await owner.db.insert(users).values({
      id: invited,
      email: 'invited-history@example.com',
      name: 'Invited agent',
      status: 'invited',
    });
    await owner.db
      .insert(userBrandRoles)
      .values({ userId: invited, brandId: BRAND, role: 'agent', departmentIds: [DEPARTMENT] });
    const input = request('invited-assignee');
    input.resolved.assigneeId = invited;
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, input));
    expect(
      (await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId)))[0]?.assigneeId,
    ).toBe(invited);
    expect((await owner.db.select().from(users).where(eq(users.id, invited)))[0]?.status).toBe(
      'invited',
    );
    expect(await owner.db.select().from(outbox)).toHaveLength(0);
  });

  it('keeps authors, note visibility and original dates while sanitizing remote content', async () => {
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, request()));
    expect(loaded).toMatchObject({ outcome: 'created', messages: 2 });
    const [ticket] = await owner.db.select().from(tickets).where(eq(tickets.id, loaded.ticketId));
    expect(ticket).toMatchObject({
      createdAt: new Date('2019-01-01T00:00:00Z'),
      updatedAt: new Date('2019-01-03T00:00:00Z'),
      importSource: 'zendesk',
      slaPolicyId: null,
    });
    expect(ticket?.number).toBeGreaterThan(0);
    expect(ticket?.number).not.toBe(900);
    const thread = await owner.db
      .select()
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, loaded.ticketId))
      .orderBy(ticketMessages.seq);
    expect(
      thread.map((message) => [
        message.seq,
        message.kind,
        message.authorType,
        message.authorDisplay,
      ]),
    ).toEqual([
      [1, 'public', 'contact', null],
      [2, 'note', 'system', 'Original agent'],
    ]);
    expect(thread[0]?.bodyHtml).not.toMatch(/script|tracker/);
    expect(await owner.db.select().from(outbox)).toHaveLength(0);
    for (const table of [
      'workflow_runs',
      'ticket_sla_clocks',
      'notifications',
      'ai_calls',
      'webhook_deliveries',
    ]) {
      const rows = await owner.db.execute(
        sql`SELECT count(*)::int AS total FROM ${sql.identifier(table)}`,
      );
      expect(rows[0]?.total, table).toBe(0);
    }
    expect(await redis.dbsize()).toBe(0);
  });

  it('writes nothing on a repeat and appends delta replies without rewriting historical messages', async () => {
    const payload = request('delta');
    const first = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    const before = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${first.ticketId}`,
    );
    const repeated = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    expect(repeated).toMatchObject({ outcome: 'unchanged', messages: 0 });
    payload.messages.push({
      externalId: 'new-reply',
      ticketExternalId: 'delta',
      authorExternalId: 'staff',
      authorKind: 'agent',
      public: true,
      bodyText: 'New reply',
      createdAt: '2019-01-03T00:00:00Z',
      attachments: [],
    });
    const delta = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    expect(delta).toMatchObject({ ticketId: first.ticketId, outcome: 'updated', messages: 1 });
    const after = await owner.db.execute(
      sql`SELECT id, xmin::text AS revision FROM ticket_messages WHERE ticket_id = ${first.ticketId} AND seq <= 2`,
    );
    expect([...after]).toEqual([...before]);
  });

  it('keeps one asset identity when the same file appears in two historical messages', async () => {
    const payload = request('attachments');
    for (const message of payload.messages)
      message.attachments.push({
        externalId: 'shared-file',
        fileName: '../../screenshot.png',
        contentType: 'image/png',
        url: 'https://files.example.com/file?expires=first',
      });
    const loaded = await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload));
    const files = await owner.db
      .select()
      .from(attachments)
      .where(eq(attachments.ticketId, loaded.ticketId));
    expect(files).toHaveLength(2);
    expect(new Set(files.map((file) => file.s3Key)).size).toBe(1);
    expect(files.filter((file) => file.copiedFromAttachmentId !== null)).toHaveLength(1);
    expect(files.every((file) => file.originalName === 'screenshot.png')).toBe(true);
    const ledger = await owner.db
      .select()
      .from(importExternalIds)
      .where(eq(importExternalIds.externalId, 'shared-file'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.helpdockId).toBe(
      files.find((file) => file.copiedFromAttachmentId === null)?.id,
    );
    for (const message of payload.messages)
      for (const file of message.attachments)
        file.url = 'https://files.example.com/file?expires=second';
    expect(await withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload))).toMatchObject({
      outcome: 'unchanged',
      messages: 0,
    });
  });

  it('rolls back a ticket and its prior messages when a later author is unmapped', async () => {
    const payload = request('rollback');
    delete payload.authors.oldagent;
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload)),
    ).rejects.toMatchObject({ code: 'author-unmapped' });
    const rows = await owner.db.execute(
      sql`SELECT count(*)::int AS total FROM import_external_ids WHERE external_id LIKE '%rollback%'`,
    );
    expect(rows[0]?.total).toBe(0);
  });

  it('refuses a department from another brand before writing any history', async () => {
    const payload = request('isolation');
    payload.resolved.departmentId = OTHER_DEPARTMENT;
    await expect(
      withSystem(app.db, BRAND, (tx) => writer.ticket(tx, payload)),
    ).rejects.toMatchObject({ code: 'mapping-invalid' });
  });
});
