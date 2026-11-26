import type { Env } from '@helpdock/config';
import {
  accounts,
  attachments,
  brandDomains,
  brands,
  contactIdentities,
  contacts,
  createDb,
  customerSessions,
  type DbHandle,
  departments,
  ticketMessages,
  ticketParticipants,
  ticketStatuses,
  tickets,
  uuidv7,
  withSystem,
  withTenant,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { PRIVATE_CACHE_CONTROL } from '../help-center/site/site.js';
import { createLogger } from '../logging/logger.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { FakeStorage } from '../testing/media.js';
import { customerTenantContext, loadCustomerScope } from './customer-context.js';
import { ccTicketIds, scopedTickets, stateWhere } from './db-ticket-reader.js';
import { asSystem, insertSession } from './portal-store.js';
import { hashToken, newToken, SESSION_TTL_MS } from './session-rules.js';

/**
 * M21-03 against a real Postgres: the ticket list and page the portal draws,
 * through the api's own routes and the real row-level-security policies. What
 * each page must show, and above all what it must never show, is asserted on
 * the HTML a customer would receive.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 46).toString('base64');
const CONTAINER_STARTUP_MS = 120_000;
const HOST_A = 'help.acme.test';
const HOST_B = 'help.globex.test';

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write('Skipping the M21-03 ticket integration tests: Docker is not available.\n');
}

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly cookies: readonly { name: string; value: string; maxAge?: number }[];
}

type Visibility = 'own' | 'managers' | 'all';

const mainOf = (reply: Reply): string => /<main[\s\S]*<\/main>/.exec(reply.body)?.[0] ?? '';
const refsOf = (reply: Reply): string[] =>
  [...mainOf(reply).matchAll(/class="hd-pt-ref" dir="ltr">([A-Z0-9-]+)</g)].map(
    (match) => match[1] ?? '',
  );

describe.skipIf(!hasDocker)('the customer portal ticket pages (M21-03)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let storage: FakeStorage;
  let brandB: string;
  let supportId: string;
  let hrId: string;
  let supportB: string;
  const status: Record<string, string> = {};
  const statusB: Record<string, string> = {};
  const who: Record<string, string> = {};
  const t: Record<string, string> = {};
  const refs: Record<string, string> = {};
  let number = 100;
  let prefixA = '';

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

  const brandA = () => seeded.brandId;

  const get = async (
    host: string,
    url: string,
    cookies: Record<string, string> = {},
  ): Promise<Reply> => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { host },
      remoteAddress: '203.0.113.9',
      cookies,
    });
    return {
      status: response.statusCode,
      body: response.body,
      headers: response.headers,
      cookies: response.cookies,
    };
  };

  const setPortal = (brandId: string, portal: Record<string, unknown>) =>
    owner.db.execute(
      sql`update brands set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ portal })}::jsonb where id = ${brandId}`,
    );

  const setVisibility = (visibility: Visibility) =>
    withSystem(runtime.db, brandA(), (tx) =>
      tx
        .update(accounts)
        .set({ portalVisibility: visibility })
        .where(eq(accounts.id, who.acme ?? '')),
    );

  const addContact = async (
    brandId: string,
    key: string,
    values: Partial<typeof contacts.$inferInsert> = {},
    verified = true,
  ): Promise<void> => {
    const id = uuidv7();
    who[key] = id;
    await withSystem(runtime.db, brandId, async (tx) => {
      await tx.insert(contacts).values({ id, brandId, name: key, ...values });
      await tx.insert(contactIdentities).values({
        brandId,
        contactId: id,
        kind: 'email',
        value: `${key}@example.com`,
        verified,
        source: 'test',
      });
    });
  };

  /** A signed-in browser for a contact: a live session row and the cookie that names it. */
  const cookieFor = async (
    contact: string,
    brandId = brandA(),
    host = HOST_A,
  ): Promise<Record<string, string>> => {
    const token = newToken();
    const [identity] = await withSystem(runtime.db, brandId, (tx) =>
      tx
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.contactId, who[contact] ?? '')),
    );
    await asSystem(runtime.db, brandId, (tx) =>
      insertSession(tx, {
        brandId,
        contactId: who[contact] ?? '',
        identityId: identity?.id ?? '',
        tokenHash: hashToken(token),
        host,
        userAgentFamily: null,
        now: new Date(),
      }),
    );
    return { '__Host-hd_cs': token };
  };

  const seedTicket = async (
    key: string,
    values: Partial<typeof tickets.$inferInsert> & { contactId: string | null },
    brandId = brandA(),
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    number += 1;
    const isB = brandId === brandB;
    refs[key] = `${isB ? 'GLBX' : prefixA}-${String(number)}`;
    await withSystem(runtime.db, brandId, (tx) =>
      tx.insert(tickets).values({
        id,
        brandId,
        departmentId: isB ? supportB : supportId,
        number,
        prefix: isB ? 'GLBX' : prefixA,
        subject: `Subject ${key}`,
        statusId: isB ? (statusB.open ?? '') : (status.open ?? ''),
        channel: 'email',
        ...values,
      }),
    );
  };

  let seq = 0;
  const seedMessage = async (
    key: string,
    ticketKey: string,
    kind: 'public' | 'note' | 'ai' | 'system',
    text: string,
    author: { type: 'staff' | 'contact' | 'ai' | 'system'; id: string | null } = {
      type: 'contact',
      id: null,
    },
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    seq += 1;
    await withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(ticketMessages).values({
        id,
        brandId: brandA(),
        ticketId: t[ticketKey] ?? '',
        departmentId: supportId,
        seq,
        kind,
        authorType: author.type,
        authorId: author.id,
        bodyHtml: `<p>${text}</p>`,
        bodyText: text,
        channel: 'email',
        createdAt: new Date(Date.UTC(2026, 10, 1, 9, seq)),
      }),
    );
  };

  const seedFile = async (
    key: string,
    ticketKey: string,
    messageKey: string,
    fileStatus: 'ready' | 'pending' = 'ready',
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    await withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(attachments).values({
        id,
        brandId: brandA(),
        ticketId: t[ticketKey] ?? '',
        departmentId: supportId,
        messageId: t[messageKey] ?? null,
        uploaderType: 'contact',
        uploaderId: 'test',
        s3Key: `brands/${brandA()}/tickets/${t[ticketKey] ?? ''}/${id}/original`,
        originalName: `${key}.pdf`,
        mime: 'application/pdf',
        size: 10,
        kind: 'file',
        status: fileStatus,
        variants: { original: { mime: 'application/pdf', size: 10 } },
      }),
    );
  };

  const ccOf = (ticketKey: string, contactKey: string, source: 'agent' | 'email') =>
    withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(ticketParticipants).values({
        brandId: brandA(),
        ticketId: t[ticketKey] ?? '',
        departmentId: supportId,
        contactId: who[contactKey] ?? '',
        address: `${contactKey}@example.com`,
        source,
      }),
    );

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new PostgreSqlContainer(POSTGRES_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
      new RedisContainer(REDIS_IMAGE).withStartupTimeout(CONTAINER_STARTUP_MS).start(),
    ]);
    owner = createDb({ url: postgres.getConnectionUri(), max: 2 });
    await owner.db.execute(sql.raw('CREATE DATABASE helpdock'));
    await owner.close();
    owner = createDb({
      url: `postgres://${postgres.getUsername()}:${postgres.getPassword()}@${postgres.getHost()}:${postgres.getPort()}/helpdock`,
      max: 2,
    });
    runtime = await createRuntime({
      env: envFor(),
      logger: createLogger({ env: { APP_ROLE: 'api', NODE_ENV: 'test', LOG_LEVEL: 'silent' } }),
    });
    storage = new FakeStorage('/tmp/helpdock-portal-tickets');
    app = await createApiApp({ runtime, objectStorage: storage });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    brandB = uuidv7();
    supportB = uuidv7();
    await owner.db.insert(brands).values({ id: brandB, name: 'Globex', prefix: 'GLBX' });
    await owner.db.insert(brandDomains).values([
      {
        brandId: brandA(),
        domain: HOST_A,
        kind: 'helpcenter',
        verifiedAt: new Date(),
        isPrimary: true,
        txtToken: 'helpdock-verify=a',
      },
      {
        brandId: brandB,
        domain: HOST_B,
        kind: 'helpcenter',
        verifiedAt: new Date(),
        isPrimary: true,
        txtToken: 'helpdock-verify=b',
      },
    ]);

    await withSystem(runtime.db, brandA(), async (tx) => {
      const [brand] = await tx
        .select({ prefix: brands.prefix })
        .from(brands)
        .where(eq(brands.id, brandA()));
      prefixA = brand?.prefix ?? 'HD';
      const [support] = await tx
        .select()
        .from(departments)
        .where(eq(departments.brandId, brandA()));
      supportId = support?.id ?? '';
      hrId = uuidv7();
      await tx.insert(departments).values({ id: hrId, brandId: brandA(), name: 'HR' });
      for (const row of await tx
        .select()
        .from(ticketStatuses)
        .where(eq(ticketStatuses.brandId, brandA()))) {
        status[row.systemKey ?? row.name] = row.id;
      }
    });
    await withSystem(runtime.db, brandB, async (tx) => {
      await tx.insert(departments).values({ id: supportB, brandId: brandB, name: 'Support' });
      await tx.insert(ticketStatuses).values({
        brandId: brandB,
        name: 'Open',
        systemState: 'open',
        isDefault: true,
        color: 'info',
      });
      for (const row of await tx
        .select()
        .from(ticketStatuses)
        .where(eq(ticketStatuses.brandId, brandB))) {
        statusB[row.systemKey ?? 'open'] = row.id;
      }
    });
    await setPortal(brandA(), { enabled: true, departmentIds: [supportId] });
    await setPortal(brandB, { enabled: true });

    who.acme = uuidv7();
    who.zedCo = uuidv7();
    await withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(accounts).values([
        { id: who.acme ?? '', brandId: brandA(), name: 'Acme Trading', portalVisibility: 'own' },
        { id: who.zedCo ?? '', brandId: brandA(), name: 'Zed Co', portalVisibility: 'all' },
      ]),
    );
    await addContact(brandA(), 'mona', { accountId: who.acme ?? null });
    await addContact(brandA(), 'omar', { accountId: who.acme ?? null });
    await addContact(brandA(), 'maya', { accountId: who.acme ?? null, accountRole: 'manager' });
    await addContact(brandA(), 'lena');
    await addContact(brandA(), 'zed', { accountId: who.zedCo ?? null });
    await addContact(brandA(), 'unverified', { accountId: who.acme ?? null }, false);
    await addContact(brandB, 'monaB');

    // Mona's own tickets.
    await seedTicket('monaOpen', { contactId: who.mona ?? null });
    await seedMessage('monaPublic', 'monaOpen', 'public', 'PUBLIC-MESSAGE-TEXT', {
      type: 'contact',
      id: who.mona ?? null,
    });
    await seedMessage('monaNote', 'monaOpen', 'note', 'SECRET-NOTE-TEXT', {
      type: 'staff',
      id: null,
    });
    await seedMessage('monaAi', 'monaOpen', 'ai', 'AI-ANSWER-TEXT', { type: 'ai', id: null });
    await seedMessage('monaSystem', 'monaOpen', 'system', 'SYSTEM-TRAIL-TEXT', {
      type: 'system',
      id: null,
    });
    await seedFile('monaFile', 'monaOpen', 'monaPublic');
    await seedFile('monaNoteFile', 'monaOpen', 'monaNote');
    await seedFile('monaPendingFile', 'monaOpen', 'monaPublic', 'pending');
    await seedTicket('monaWaiting', {
      contactId: who.mona ?? null,
      statusId: status.awaiting_customer ?? '',
    });
    await seedTicket('monaSolved', {
      contactId: who.mona ?? null,
      statusId: status.closed ?? '',
      closedAt: new Date(),
    });
    await seedTicket('monaPrivate', { contactId: who.mona ?? null, portalPrivate: true });
    await seedTicket('monaHr', { contactId: who.mona ?? null, departmentId: hrId });
    await seedTicket('monaDeleted', { contactId: who.mona ?? null, deletedAt: new Date() });
    await seedTicket('monaSpam', {
      contactId: who.mona ?? null,
      statusId: status.spam ?? '',
      closedAt: new Date(),
    });
    await seedTicket('monaEscalated', {
      contactId: who.mona ?? null,
      statusId: status.escalated ?? '',
    });
    await seedTicket('monaSnoozed', {
      contactId: who.mona ?? null,
      snoozedUntil: new Date(Date.now() + 86_400_000),
    });

    await seedTicket('omarPrivate', { contactId: who.omar ?? null, portalPrivate: true });

    // Merged: the secondary's messages read through the primary.
    await seedTicket('primary', { contactId: who.mona ?? null });
    await seedMessage('primaryOwn', 'primary', 'public', 'PRIMARY-OWN-TEXT', {
      type: 'contact',
      id: who.mona ?? null,
    });
    await seedTicket('secondary', {
      contactId: who.mona ?? null,
      mergedIntoId: t.primary ?? null,
      statusId: status.merged ?? '',
      closedAt: new Date(),
    });
    await seedMessage('secondaryPublic', 'secondary', 'public', 'MERGED-PUBLIC-TEXT', {
      type: 'contact',
      id: who.mona ?? null,
    });
    await seedMessage('secondaryNote', 'secondary', 'note', 'MERGED-NOTE-TEXT', {
      type: 'staff',
      id: null,
    });
    await seedFile('secondaryFile', 'secondary', 'secondaryPublic');
    await seedFile('secondaryNoteFile', 'secondary', 'secondaryNote');
    await seedTicket('foreignSecondary', {
      contactId: who.zed ?? null,
      mergedIntoId: t.primary ?? null,
      statusId: status.merged ?? '',
      closedAt: new Date(),
    });
    await seedTicket('secondaryOfHidden', {
      contactId: who.mona ?? null,
      mergedIntoId: t.omarPrivate ?? null,
      statusId: status.merged ?? '',
    });

    // The company.
    await seedTicket('omarTicket', { contactId: who.omar ?? null });
    await seedMessage('omarMessage', 'omarTicket', 'public', 'OMAR-MESSAGE-TEXT', {
      type: 'contact',
      id: who.omar ?? null,
    });
    await seedFile('omarFile', 'omarTicket', 'omarMessage');
    await seedTicket('mayaTicket', { contactId: who.maya ?? null });
    await seedTicket('zedTicket', { contactId: who.zed ?? null });
    await seedTicket('lenaTicket', { contactId: who.lena ?? null });
    await seedMessage('zedMessage', 'zedTicket', 'public', 'ZED-MESSAGE-TEXT', {
      type: 'contact',
      id: who.zed ?? null,
    });
    await seedFile('zedFile', 'zedTicket', 'zedMessage');

    // CCs: a staff-added one gives access, one that mail made does not.
    await seedTicket('ccAgent', { contactId: who.omar ?? null });
    await ccOf('ccAgent', 'mona', 'agent');
    await seedTicket('ccEmail', { contactId: who.omar ?? null });
    await ccOf('ccEmail', 'mona', 'email');

    await seedTicket('monaB', { contactId: who.monaB ?? null }, brandB);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  const list = async (who_: string, query = '', host = HOST_A) =>
    get(host, `/tickets${query}`, await cookieFor(who_));

  describe('the list', () => {
    it('shows a customer their own tickets, newest change first, and nothing the policy or the page hides', async () => {
      await setVisibility('own');
      const reply = await list('mona');
      const refsShown = refsOf(reply);

      expect(reply.status).toBe(200);
      expect(reply.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      expect(reply.headers['x-robots-tag']).toBe('noindex');
      for (const key of [
        'monaOpen',
        'monaWaiting',
        'monaPrivate',
        'monaEscalated',
        'monaSnoozed',
        'primary',
        'ccAgent',
      ]) {
        expect(refsShown, key).toContain(refs[key]);
      }
      for (const key of [
        'monaSolved',
        'monaHr',
        'monaDeleted',
        'monaSpam',
        'secondary',
        'omarTicket',
        'omarPrivate',
        'zedTicket',
        'lenaTicket',
        'ccEmail',
        'monaB',
        'foreignSecondary',
      ]) {
        expect(refsShown, key).not.toContain(refs[key]);
      }
      expect(mainOf(reply)).not.toContain('hd-pt-count');
    });

    it('says the four words, with a snoozed ticket as Waiting for us', async () => {
      await setVisibility('own');
      const body = mainOf(await list('mona'));
      const row = (key: string) =>
        new RegExp(`${refs[key] ?? ''}<[\\s\\S]*?</a></li>`).exec(body)?.[0] ?? '';

      expect(row('monaOpen')).toContain('Open</span>');
      expect(row('monaWaiting')).toContain('Waiting for you');
      expect(row('monaEscalated')).toContain('Waiting for us');
      expect(row('monaSnoozed')).toContain('Waiting for us');
      expect(row('monaPrivate')).toContain('Only you');
      const solved = mainOf(await list('mona', '?state=solved'));
      expect(refsOf({ body: solved } as Reply)).toEqual([refs.monaSolved]);
      expect(solved).toContain('>Solved</span>');
    });

    it('under own tickets, never lets a member switch to Company, whatever they ask for', async () => {
      await setVisibility('own');
      const reply = await list('mona', '?scope=company');

      expect(refsOf(reply)).not.toContain(refs.omarTicket);
      expect(refsOf(reply)).toContain(refs.monaOpen);
    });

    it('under managers, shows a manager the company and a member only their own', async () => {
      await setVisibility('managers');
      const manager = await list('maya', '?scope=company');
      const member = await list('mona', '?scope=company');

      expect(refsOf(manager)).toEqual(
        expect.arrayContaining([refs.omarTicket, refs.mayaTicket, refs.monaOpen]),
      );
      expect(refsOf(manager)).not.toContain(refs.omarPrivate);
      expect(refsOf(manager)).not.toContain(refs.zedTicket);
      expect(refsOf(manager)).not.toContain(refs.lenaTicket);
      expect(mainOf(manager)).toContain(
        'You can see every ticket of Acme Trading because you are a company manager.',
      );
      expect(refsOf(member)).not.toContain(refs.omarTicket);
      expect(mainOf(member)).not.toContain('hd-pt-count');
    });

    it('under all members, shows every member the company, "Opened by" on each row, and tells them so', async () => {
      await setVisibility('all');
      const mine = await list('mona');
      const company = await list('mona', '?scope=company');

      expect(mainOf(mine)).toContain('People at Acme Trading can see the tickets you open here');
      expect(mainOf(mine)).toContain('Acme Trading<span class="hd-pt-count">');
      expect(refsOf(mine)).not.toContain(refs.omarTicket);
      expect(refsOf(company)).toEqual(
        expect.arrayContaining([refs.omarTicket, refs.mayaTicket, refs.monaOpen, refs.ccAgent]),
      );
      expect(refsOf(company)).not.toContain(refs.omarPrivate);
      expect(refsOf(company)).not.toContain(refs.zedTicket);
      expect(refsOf(company)).not.toContain(refs.monaHr);
      expect(mainOf(company)).toContain('Opened by omar');
      expect(mainOf(company)).toContain('Opened by you');
      expect(mainOf(company)).not.toContain('example.com');
    });

    it('shows a customer their own private ticket in the company view too, and no coworker ever sees it', async () => {
      await setVisibility('all');

      expect(refsOf(await list('mona', '?scope=company'))).toContain(refs.monaPrivate);
      expect(refsOf(await list('omar', '?scope=company'))).not.toContain(refs.monaPrivate);
      expect(refsOf(await list('maya', '?scope=company'))).not.toContain(refs.monaPrivate);
    });

    it('lists a ticket where a staff-added CC is the customer, and not one only mail copied them on', async () => {
      await setVisibility('own');
      const reply = await list('mona');

      expect(refsOf(reply)).toContain(refs.ccAgent);
      expect(refsOf(reply)).not.toContain(refs.ccEmail);
    });

    it('lists nothing for a contact who never proved their mailbox: there is no session to ask with', async () => {
      const response = await get(HOST_A, '/tickets', await cookieFor('unverified'));

      expect(response.status).toBe(303);
      expect(response.headers.location).toMatch(/^\/sign-in/);
    });

    it('finds tickets by subject and by reference, only among those the customer may see', async () => {
      await setVisibility('all');

      expect(refsOf(await list('mona', '?q=Subject%20monaOpen'))).toEqual([refs.monaOpen]);
      expect(refsOf(await list('mona', `?q=${refs.monaWaiting ?? ''}`))).toEqual([
        refs.monaWaiting,
      ]);
      expect(refsOf(await list('mona', `?q=${(refs.monaWaiting ?? '').toLowerCase()}`))).toEqual([
        refs.monaWaiting,
      ]);
      expect(refsOf(await list('mona', '?q=Subject%20zedTicket&scope=company'))).toEqual([]);
      expect(refsOf(await list('mona', '?q=Subject%20omarPrivate&scope=company'))).toEqual([]);
      expect(refsOf(await list('mona', `?q=${refs.zedTicket ?? ''}&scope=company`))).toEqual([]);
      expect(refsOf(await list('mona', '?q=Subject%20omarTicket&scope=company'))).toEqual([
        refs.omarTicket,
      ]);
    });

    it('takes a hostile search as data: wildcards are literal and quotes do nothing', async () => {
      await setVisibility('own');

      expect(refsOf(await list('mona', '?q=%25'))).toEqual([]);
      expect(refsOf(await list('mona', '?q=_____'))).toEqual([]);
      const quoted = await list('mona', `?q=${encodeURIComponent("' or 1=1 --")}`);
      expect(quoted.status).toBe(200);
      expect(refsOf(quoted)).toEqual([]);
    });

    it('refuses a forged cursor by starting over, and a malformed state or scope by their defaults', async () => {
      await setVisibility('own');
      const reply = await list('mona', '?cursor=%27%3B--&state=zzz&scope=zzz');

      expect(reply.status).toBe(200);
      expect(refsOf(reply)).toContain(refs.monaOpen);
    });

    it('pages 20 at a time without skipping or repeating a row, including rows changed at the same instant', async () => {
      await setVisibility('own');
      const at = new Date('2026-10-01T10:00:00.000Z');
      for (let n = 0; n < 45; n += 1) {
        await seedTicket(`bulk${String(n)}`, {
          contactId: who.lena ?? null,
          // Groups of five share an instant, so only the id breaks the tie.
          updatedAt: new Date(at.getTime() - Math.floor(n / 5) * 60_000),
        });
      }
      const cookies = await cookieFor('lena');
      const seen: string[] = [];
      let url = '/tickets?lang=en';
      for (let page = 0; page < 5; page += 1) {
        const reply = await get(HOST_A, url, cookies);
        seen.push(...refsOf(reply));
        const next = /href="([^"]*cursor=[^"]+)"/.exec(mainOf(reply))?.[1];
        if (next === undefined) {
          break;
        }
        url = next.replaceAll('&amp;', '&');
      }
      const bulk = Array.from({ length: 45 }, (_, n) => refs[`bulk${String(n)}`] ?? '');

      expect(seen).toHaveLength(46);
      expect(new Set(seen).size).toBe(46);
      expect(seen.filter((ref) => bulk.includes(ref))).toHaveLength(45);
      expect(seen.slice(0, 20)).toHaveLength(20);
    });

    it('uses an index, not a scan of every ticket, for a customer among thousands', async () => {
      await owner.db.execute(sql`
        insert into tickets (id, brand_id, department_id, number, prefix, subject, status_id, channel, contact_id, updated_at)
        select gen_random_uuid(), ${brandA()}::uuid, ${supportId}::uuid, 100000 + g, ${prefixA}, 'filler', ${status.open ?? ''}::uuid, 'email', ${who.zed ?? ''}::uuid,
               now() - (g || ' seconds')::interval
        from generate_series(1, 6000) g`);
      await owner.db.execute(sql`analyze tickets`);
      const scope = await loadCustomerScope(runtime.db, {
        brandId: brandA(),
        contactId: who.mona ?? '',
      });

      const cc = await ccTicketIds(runtime.db, scope);
      for (const which of ['mine', 'company'] as const) {
        await setVisibility('all');
        const live = await loadCustomerScope(runtime.db, {
          brandId: brandA(),
          contactId: who.mona ?? '',
        });
        const plan = await withTenant(runtime.db, customerTenantContext(live), async (tx) => {
          const query = tx
            .select({ id: tickets.id })
            .from(tickets)
            .where(and(scopedTickets(live, which, cc), stateWhere('open')))
            .orderBy(desc(tickets.updatedAt), desc(tickets.id))
            .limit(21);
          const result = await tx.execute(sql`explain (format json) ${query}`);
          return JSON.stringify(result);
        });

        // Not the policy's `@>` (it is not leakproof, so it cannot drive an index): the leakproof
        // equalities `scopedTickets` adds, which can.
        expect(plan, which).toContain('tickets_brand_contact_idx');
        if (which === 'company') {
          expect(plan).toContain('tickets_brand_account_idx');
        }
        expect(plan, which).not.toContain('"Node Type":"Seq Scan"');
      }
      expect(scope.sees).toBe('own');
    });
  });

  describe('a ticket', () => {
    it('shows the public, ai and customer messages, in order, and never a note or the system trail', async () => {
      await setVisibility('own');
      const cookies = await cookieFor('mona');
      const reply = await get(HOST_A, `/tickets/${refs.monaOpen ?? ''}`, cookies);
      const body = mainOf(reply);

      expect(reply.status).toBe(200);
      expect(reply.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      expect(body).toContain('PUBLIC-MESSAGE-TEXT');
      expect(body).toContain('AI-ANSWER-TEXT');
      expect(body.indexOf('PUBLIC-MESSAGE-TEXT')).toBeLessThan(body.indexOf('AI-ANSWER-TEXT'));
      expect(reply.body).not.toContain('SECRET-NOTE-TEXT');
      expect(reply.body).not.toContain('SYSTEM-TRAIL-TEXT');
      expect(body).toContain('<bdi>You</bdi>');
      expect(body).toContain(`>${refs.monaOpen ?? ''}<`);
      expect(body).toContain('Opened by you');
    });

    it('lists the files of its public messages as links, and not a note’s or an unfinished upload', async () => {
      const cookies = await cookieFor('mona');
      const body = mainOf(await get(HOST_A, `/tickets/${refs.monaOpen ?? ''}`, cookies));

      expect(body).toContain(`/attachments/${t.monaFile ?? ''}`);
      expect(body).not.toContain(t.monaNoteFile ?? 'x');
      expect(body).not.toContain(t.monaPendingFile ?? 'x');
      expect(body).not.toContain('brands/');
    });

    it('reads a coworker’s ticket in the company view, and says whose it is', async () => {
      await setVisibility('all');
      const body = mainOf(
        await get(HOST_A, `/tickets/${refs.omarTicket ?? ''}`, await cookieFor('mona')),
      );

      expect(body).toContain('OMAR-MESSAGE-TEXT');
      expect(body).toContain('Opened by omar');
      expect(body).toContain('<span class="hd-pt-tag">Coworker</span>');
    });

    it('draws the messages of a ticket merged into it, and not its notes', async () => {
      const reply = await get(HOST_A, `/tickets/${refs.primary ?? ''}`, await cookieFor('mona'));

      expect(reply.status).toBe(200);
      expect(reply.body).toContain('PRIMARY-OWN-TEXT');
      expect(reply.body).toContain('MERGED-PUBLIC-TEXT');
      expect(reply.body).not.toContain('MERGED-NOTE-TEXT');
      expect(reply.body.indexOf('PRIMARY-OWN-TEXT')).toBeLessThan(
        reply.body.indexOf('MERGED-PUBLIC-TEXT'),
      );
      expect(reply.body).toContain(`/attachments/${t.secondaryFile ?? ''}`);
      expect(reply.body).not.toContain(t.secondaryNoteFile ?? 'x');
    });

    it('sends a merged-away reference to the ticket it was merged into, when the customer can see that one', async () => {
      const reply = await get(HOST_A, `/tickets/${refs.secondary ?? ''}`, await cookieFor('mona'));

      expect(reply.status).toBe(303);
      expect(reply.headers.location).toBe(`/tickets/${refs.primary ?? ''}?lang=en`);
    });

    it('answers 404 for a merged-away reference whose primary the customer cannot see', async () => {
      await setVisibility('own');
      const reply = await get(
        HOST_A,
        `/tickets/${refs.secondaryOfHidden ?? ''}`,
        await cookieFor('mona'),
      );

      expect(reply.status).toBe(404);
      expect(reply.headers.location).toBeUndefined();
    });

    it.each([
      ['a ticket in a department the portal does not show', 'monaHr', 'all'],
      ['a deleted ticket', 'monaDeleted', 'all'],
      ['a spam ticket', 'monaSpam', 'all'],
      ['a coworker’s private ticket', 'omarPrivate', 'all'],
      ['a ticket of another company', 'zedTicket', 'all'],
      ['a ticket a CC from mail was copied on', 'ccEmail', 'own'],
      ['another brand’s ticket', 'monaB', 'all'],
    ] as const)(
      'answers the help center 404, privately, for %s',
      async (_name, key, visibility) => {
        await setVisibility(visibility);
        const reply = await get(HOST_A, `/tickets/${refs[key] ?? ''}`, await cookieFor('mona'));

        expect(reply.status).toBe(404);
        expect(reply.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
        expect(reply.body).toContain('We can’t find that page');
        expect(reply.body).not.toContain('Subject ');
      },
    );

    it('answers a ticket that is not theirs with the same page as one that does not exist', async () => {
      await setVisibility('own');
      const cookies = await cookieFor('mona');
      const hidden = await get(HOST_A, `/tickets/${refs.omarTicket ?? ''}`, cookies);
      const missing = await get(HOST_A, `/tickets/${prefixA}-999999`, cookies);
      const strip = (body: string) =>
        body.replace(/nonce="[^"]+"/g, '').replace(/name="csrf" value="[^"]+"/g, '');

      expect(hidden.status).toBe(404);
      expect(strip(hidden.body)).toBe(strip(missing.body));
    });

    it('does not read a ticket on the other brand’s host with this brand’s session', async () => {
      const reply = await get(HOST_B, `/tickets/${refs.monaB ?? ''}`, await cookieFor('mona'));

      expect(reply.status).toBe(303);
      expect(reply.headers.location).toMatch(/^\/sign-in/);
    });

    it('lets another brand’s customer read their own ticket, and not this brand’s', async () => {
      const cookies = await cookieFor('monaB', brandB, HOST_B);

      expect((await get(HOST_B, `/tickets/${refs.monaB ?? ''}`, cookies)).status).toBe(200);
      expect((await get(HOST_B, `/tickets/${refs.monaOpen ?? ''}`, cookies)).status).toBe(404);
    });
  });

  describe('a file', () => {
    const file = (ticketKey: string, fileKey: string) =>
      `/tickets/${refs[ticketKey] ?? ''}/attachments/${t[fileKey] ?? ''}`;

    it('redirects to a short-lived address for a file of a visible ticket, privately', async () => {
      await setVisibility('own');
      const reply = await get(HOST_A, file('monaOpen', 'monaFile'), await cookieFor('mona'));

      expect(reply.status).toBe(303);
      expect(String(reply.headers.location)).toMatch(/^https:\/\/bucket\.test\//);
      expect(String(reply.headers.location)).toContain(
        encodeURIComponent(`${t.monaFile ?? ''}/original`),
      );
      expect(reply.headers['cache-control']).toBe(PRIVATE_CACHE_CONTROL);
      expect(storage.presignedDownloads.at(-1)).toMatchObject({ fileName: 'monaFile.pdf' });
    });

    it('redirects for a file on a ticket merged into one the customer can see', async () => {
      const reply = await get(HOST_A, file('primary', 'secondaryFile'), await cookieFor('mona'));

      expect(reply.status).toBe(303);
      expect(String(reply.headers.location)).toContain(
        encodeURIComponent(`${t.secondaryFile ?? ''}/original`),
      );
    });

    it.each([
      ['a note’s file', 'monaOpen', 'monaNoteFile'],
      ['an upload that is not ready', 'monaOpen', 'monaPendingFile'],
      ['another customer’s file, under the ticket they name', 'monaOpen', 'zedFile'],
      ['a file of a ticket the customer cannot see', 'zedTicket', 'zedFile'],
      ['a coworker’s file when the account is not shared', 'omarTicket', 'omarFile'],
      ['a merged ticket’s note file', 'primary', 'secondaryNoteFile'],
      ['a file named under another of their tickets', 'monaWaiting', 'monaFile'],
    ])('answers 404 for %s', async (_name, ticketKey, fileKey) => {
      await setVisibility('own');
      const reply = await get(HOST_A, file(ticketKey, fileKey), await cookieFor('mona'));

      expect(reply.status).toBe(404);
      expect(reply.headers.location).toBeUndefined();
    });

    it('lets a member of a shared company open a coworker’s file, and not a private ticket’s', async () => {
      await setVisibility('all');
      const cookies = await cookieFor('mona');

      expect((await get(HOST_A, file('omarTicket', 'omarFile'), cookies)).status).toBe(303);
    });

    it('answers a visitor with the sign-in page, never a file', async () => {
      const reply = await get(HOST_A, file('monaOpen', 'monaFile'));

      expect(reply.status).toBe(303);
      expect(String(reply.headers.location)).toMatch(/^\/sign-in/);
    });
  });

  describe('the session on these pages', () => {
    it('renews the browser’s cookie on any portal page once the session slid', async () => {
      await setVisibility('own');
      const cookies = await cookieFor('mona');
      const old = new Date(Date.now() - 60 * 60_000);
      await withSystem(runtime.db, brandA(), (tx) =>
        tx
          .update(customerSessions)
          .set({ lastSeenAt: old })
          .where(eq(customerSessions.tokenHash, hashToken(cookies['__Host-hd_cs'] ?? ''))),
      );

      const reply = await get(HOST_A, `/tickets/${refs.monaOpen ?? ''}`, cookies);
      expect(reply.cookies).toEqual([
        expect.objectContaining({
          name: '__Host-hd_cs',
          value: cookies['__Host-hd_cs'],
          maxAge: SESSION_TTL_MS / 1000,
        }),
      ]);
      expect((await get(HOST_A, '/tickets', cookies)).cookies).toEqual([]);
    });

    it('renews it on the 404 page too', async () => {
      const cookies = await cookieFor('mona');
      await withSystem(runtime.db, brandA(), (tx) =>
        tx
          .update(customerSessions)
          .set({ lastSeenAt: new Date(Date.now() - 60 * 60_000) })
          .where(eq(customerSessions.tokenHash, hashToken(cookies['__Host-hd_cs'] ?? ''))),
      );

      const reply = await get(HOST_A, `/tickets/${prefixA}-999999`, cookies);
      expect(reply.status).toBe(404);
      expect(reply.cookies).toHaveLength(1);
    });

    it('stops reading once the brand turns the portal off', async () => {
      const cookies = await cookieFor('mona');
      await setPortal(brandA(), { enabled: false, departmentIds: [supportId] });
      try {
        expect((await get(HOST_A, '/tickets', cookies)).status).toBe(404);
      } finally {
        await setPortal(brandA(), { enabled: true, departmentIds: [supportId] });
      }
    });
  });
});
