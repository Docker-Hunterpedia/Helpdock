import { decodeMasterKey, type Env } from '@helpdock/config';
import {
  accounts,
  auditLog,
  brandDomains,
  brands,
  contactIdentities,
  contacts,
  createDb,
  customerSessions,
  type DbHandle,
  departments,
  outbox,
  ticketActivity,
  ticketParticipants,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import type {
  AccountPortal,
  ContactPortalAccess,
  PortalSettings,
  TicketDetail,
  TicketParticipantList,
  TicketPortalView,
} from '@helpdock/schemas';
import { HC_SITE_CHANGED_EVENT, parseBrandSettings } from '@helpdock/schemas';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../auth/password.js';
import { type ApiApp, createApiApp, createRuntime, type Runtime } from '../bootstrap.js';
import { createPageCacheHandler } from '../help-center/site/cache-events.js';
import { RedisPageCache } from '../help-center/site/page-cache.js';
import { createLogger } from '../logging/logger.js';
import { asSystem, insertSession } from '../portal/portal-store.js';
import { hashToken, newToken } from '../portal/session-rules.js';
import { type SeededInstall, seedDevInstall } from '../seed/dev-seed.js';
import { dockerAvailable } from '../testing/docker-available.js';
import { signInForTest } from '../testing/staff-sign-in.js';

/**
 * M21-06 against a real Postgres and Redis, over real staff sessions and real
 * customer sessions on the help center host.
 *
 * 1. **The portal setting** is merged into `settings.portal` alone, validated
 *    against the brand's own departments, audited with values, and drops the
 *    cached help center pages.
 * 2. **An account's visibility and managers** take effect on a signed-in
 *    member's next request, with no new sign-in.
 * 3. **A contact's portal access** never carries a token hash, and signing out
 *    ends the sessions on the system path.
 * 4. **The private mark** follows the ticket's department scope and hides the
 *    ticket from a coworker.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7-alpine';
const APP_ROLE_PASSWORD = 'app-role-password';
const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');
const STAFF_PASSWORD = 'a staff password';
const CONTAINER_STARTUP_MS = 120_000;
const HOST_A = 'help.acme.test';

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write('Skipping the M21-06 integration tests: Docker is not available.\n');
}

interface Person {
  readonly id: string;
  readonly email: string;
  token: string;
}

describe.skipIf(!hasDocker)('the staff side of the customer portal (M21-06)', () => {
  let postgres: StartedPostgreSqlContainer;
  let redisContainer: StartedRedisContainer;
  let runtime: Runtime;
  let app: ApiApp;
  let owner: DbHandle;
  let seeded: SeededInstall;
  let brandB: string;
  let supportId: string;
  let hrId: string;
  let supportB: string;
  let openStatus = '';
  let acme = '';
  let acmeB = '';
  let ada: Person;
  let sam: Person;
  let hana: Person;
  let vera: Person;
  let olaB: Person;
  const who: Record<string, string> = {};
  const t: Record<string, string> = {};
  const refs: Record<string, string> = {};
  let number = 200;
  let prefixA = '';
  let since = new Date();

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

  const call = <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    who: Person,
    payload?: unknown,
  ): Promise<{ status: number; body: T; raw: string }> =>
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
        raw: response.body,
      }));

  const portalSettingsPath = (brandId = brandA()) => `/api/brands/${brandId}/portal-settings`;
  const accountPath = (id: string, brandId = brandA()) =>
    `/api/brands/${brandId}/accounts/${id}/portal`;
  const contactPath = (key: string, brandId = brandA()) =>
    `/api/brands/${brandId}/contacts/${who[key] ?? ''}/portal`;
  const privatePath = (key: string, brandId = brandA()) =>
    `/api/brands/${brandId}/tickets/${t[key] ?? ''}/portal-private`;

  const storedSettings = async (brandId = brandA()): Promise<Record<string, unknown>> => {
    const [row] = await owner.db
      .select({ settings: brands.settings })
      .from(brands)
      .where(eq(brands.id, brandId));
    return (row?.settings ?? {}) as Record<string, unknown>;
  };

  const setPortal = (brandId: string, portal: Record<string, unknown>) =>
    owner.db.execute(
      sql`update brands set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ portal })}::jsonb where id = ${brandId}`,
    );

  const addPerson = async (name: string): Promise<Person> => {
    const masterKey = decodeMasterKey(MASTER_KEY);
    /* c8 ignore next 3 -- the constant above is 32 bytes. */
    if (masterKey === undefined) {
      throw new Error('the test master key is not 32 bytes of base64');
    }
    const id = uuidv7();
    const email = `${name}-${id}@helpdock.test`;
    await runtime.db.insert(users).values({
      id,
      email,
      name,
      status: 'active',
      passwordHash: await new PasswordHasher(masterKey).hash(STAFF_PASSWORD),
    });
    return { id, email, token: '' };
  };

  const addContact = async (
    brandId: string,
    key: string,
    values: Partial<typeof contacts.$inferInsert> = {},
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
        verified: true,
        source: 'test',
      });
    });
  };

  const seedTicket = async (
    key: string,
    values: Partial<typeof tickets.$inferInsert> & { contactId: string | null },
  ): Promise<void> => {
    const id = uuidv7();
    t[key] = id;
    number += 1;
    refs[key] = `${prefixA}-${String(number)}`;
    await withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(tickets).values({
        id,
        brandId: brandA(),
        departmentId: supportId,
        number,
        prefix: prefixA,
        subject: `Subject ${key}`,
        statusId: openStatus,
        channel: 'email',
        ...values,
      }),
    );
  };

  /** A signed-in browser: a live session row and the cookie that names it. */
  const cookieFor = async (contact: string): Promise<Record<string, string>> => {
    const token = newToken();
    const [identity] = await withSystem(runtime.db, brandA(), (tx) =>
      tx
        .select()
        .from(contactIdentities)
        .where(eq(contactIdentities.contactId, who[contact] ?? '')),
    );
    await asSystem(runtime.db, brandA(), (tx) =>
      insertSession(tx, {
        brandId: brandA(),
        contactId: who[contact] ?? '',
        identityId: identity?.id ?? '',
        tokenHash: hashToken(token),
        host: HOST_A,
        userAgentFamily: 'Firefox on Linux',
        now: new Date(),
      }),
    );
    return { '__Host-hd_cs': token };
  };

  const portalGet = (url: string, cookies: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url,
      headers: { host: HOST_A },
      remoteAddress: '203.0.113.9',
      cookies,
    });

  /** The references a customer sees on their ticket list. */
  const listFor = async (cookies: Record<string, string>): Promise<string[] | 'sign-in'> => {
    const response = await portalGet('/tickets?scope=company', cookies);
    if (response.statusCode === 302 || response.statusCode === 303) {
      return 'sign-in';
    }
    expect(response.statusCode).toBe(200);
    const main = /<main[\s\S]*<\/main>/.exec(response.body)?.[0] ?? '';
    return [...main.matchAll(/class="hd-pt-ref" dir="ltr">([A-Z0-9-]+)</g)].map(
      (match) => match[1] ?? '',
    );
  };

  /** What the worker's page cache subscription does with every site event since `since`. */
  const deliverSiteEvents = async (): Promise<number> => {
    const handler = createPageCacheHandler(new RedisPageCache(runtime.redis));
    const rows = await owner.db
      .select()
      .from(outbox)
      .where(eq(outbox.event, HC_SITE_CHANGED_EVENT));
    for (const row of rows.filter((candidate) => candidate.createdAt > since)) {
      await handler({
        outboxId: row.id,
        brandId: row.brandId,
        event: row.event,
        payload: row.payload as Record<string, unknown>,
        tx: undefined as never,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      });
    }
    since = new Date();
    return rows.length;
  };

  const auditRows = (action: string, brandId = brandA()) =>
    owner.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.brandId, brandId), eq(auditLog.action, action)));

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
    app = await createApiApp({ runtime });
    seeded = await seedDevInstall({ db: runtime.db, env: envFor() });

    ada = { id: seeded.userId, email: seeded.email, token: '' };
    ada.token = await signInForTest(app, { email: seeded.email, password: seeded.password });

    brandB = uuidv7();
    supportB = uuidv7();
    await owner.db.insert(brands).values({ id: brandB, name: 'Globex', prefix: 'GLBX' });
    await owner.db.insert(brandDomains).values({
      brandId: brandA(),
      domain: HOST_A,
      kind: 'helpcenter',
      verifiedAt: new Date(),
      isPrimary: true,
      txtToken: 'helpdock-verify=a',
    });

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
      const [open] = await tx
        .select()
        .from(ticketStatuses)
        .where(and(eq(ticketStatuses.brandId, brandA()), eq(ticketStatuses.isDefault, true)));
      openStatus = open?.id ?? '';
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
    });

    sam = await addPerson('sam');
    hana = await addPerson('hana');
    vera = await addPerson('vera');
    olaB = await addPerson('ola');
    await withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(userBrandRoles).values([
        { userId: sam.id, brandId: brandA(), role: 'agent', departmentIds: [supportId] },
        { userId: hana.id, brandId: brandA(), role: 'agent', departmentIds: [hrId] },
        { userId: vera.id, brandId: brandA(), role: 'viewer' },
      ]),
    );
    await withSystem(runtime.db, brandB, (tx) =>
      tx.insert(userBrandRoles).values({ userId: olaB.id, brandId: brandB, role: 'admin' }),
    );
    for (const person of [sam, hana, vera, olaB]) {
      person.token = await signInForTest(app, { email: person.email, password: STAFF_PASSWORD });
    }

    acme = uuidv7();
    acmeB = uuidv7();
    await withSystem(runtime.db, brandA(), (tx) =>
      tx.insert(accounts).values({ id: acme, brandId: brandA(), name: 'Acme Trading' }),
    );
    await withSystem(runtime.db, brandB, (tx) =>
      tx.insert(accounts).values({ id: acmeB, brandId: brandB, name: 'Globex Co' }),
    );
    await addContact(brandA(), 'mona', { accountId: acme });
    await addContact(brandA(), 'omar', { accountId: acme });
    await addContact(brandA(), 'lena');
    await addContact(brandB, 'monaB', { accountId: acmeB });

    await seedTicket('omarTicket', { contactId: who.omar ?? null });
    await seedTicket('monaTicket', { contactId: who.mona ?? null });
    await seedTicket('hrTicket', { contactId: who.omar ?? null, departmentId: hrId });
    await seedTicket('lenaTicket', { contactId: who.lena ?? null });

    await setPortal(brandA(), { enabled: true });
    since = new Date();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await runtime?.close();
    await owner?.close();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  describe('PUT portal-settings', () => {
    it('is an Admin’s: an Agent and a Viewer are refused, and so is an Admin of another brand', async () => {
      const body = { enabled: true, newCustomers: false, departmentIds: 'all' };
      expect((await call('PUT', portalSettingsPath(), sam, body)).status).toBe(403);
      expect((await call('PUT', portalSettingsPath(), vera, body)).status).toBe(403);
      expect([403, 404]).toContain((await call('PUT', portalSettingsPath(), olaB, body)).status);
      expect([403, 404]).toContain(
        (await call('PUT', portalSettingsPath(brandB), ada, body)).status,
      );
    });

    it('merges settings.portal only and leaves every other setting as it was', async () => {
      await owner.db.execute(
        sql`update brands set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ csatEnabled: true, priorityLabels: { high: { en: 'P2' } } })}::jsonb where id = ${brandA()}`,
      );
      const before = await storedSettings();

      const response = await call<PortalSettings>('PUT', portalSettingsPath(), ada, {
        enabled: true,
        newCustomers: true,
        departmentIds: [supportId],
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        enabled: true,
        newCustomers: true,
        departmentIds: [supportId],
      });

      const after = await storedSettings();
      expect(after.portal).toEqual({
        enabled: true,
        newCustomers: true,
        departmentIds: [supportId],
      });
      const { portal: _before, ...restBefore } = parseBrandSettings(before);
      const { portal: _after, ...restAfter } = after;
      expect(restAfter).toEqual(restBefore);
    });

    it('is left alone by the other settings routes', async () => {
      const portal = (await storedSettings()).portal;
      const patched = await call('PATCH', `/api/brands/${brandA()}/ticketing/feedback`, ada, {
        csatEnabled: false,
      });
      expect(patched.status).toBe(200);
      expect((await storedSettings()).portal).toEqual(portal);
    });

    it('refuses a department of another brand, an empty "only these" and a repeated id', async () => {
      const base = { enabled: true, newCustomers: false };
      const stored = (await storedSettings()).portal;

      expect(
        (await call('PUT', portalSettingsPath(), ada, { ...base, departmentIds: [supportB] }))
          .status,
      ).toBe(400);
      expect(
        (await call('PUT', portalSettingsPath(), ada, { ...base, departmentIds: [uuidv7()] }))
          .status,
      ).toBe(400);
      expect(
        (await call('PUT', portalSettingsPath(), ada, { ...base, departmentIds: [] })).status,
      ).toBe(400);
      expect(
        (
          await call('PUT', portalSettingsPath(), ada, {
            ...base,
            departmentIds: [supportId, supportId],
          })
        ).status,
      ).toBe(400);
      expect((await storedSettings()).portal).toEqual(stored);
    });

    it('audits the old and the new value of the fields that changed, and nothing for a no-op', async () => {
      await call('PUT', portalSettingsPath(), ada, {
        enabled: true,
        newCustomers: false,
        departmentIds: 'all',
      });
      const rows = await auditRows('brand.portal.updated');
      const last = rows.at(-1);
      expect(last?.actorId).toBe(ada.id);
      expect(last?.meta).toEqual({
        before: { newCustomers: true, departmentIds: [supportId] },
        after: { newCustomers: false, departmentIds: 'all' },
      });

      const count = rows.length;
      const again = await call('PUT', portalSettingsPath(), ada, {
        enabled: true,
        newCustomers: false,
        departmentIds: 'all',
      });
      expect(again.status).toBe(200);
      expect(await auditRows('brand.portal.updated')).toHaveLength(count);
    });

    it('drops the cached help center pages: the Sign in link is there right after enabling', async () => {
      await call('PUT', portalSettingsPath(), ada, {
        enabled: false,
        newCustomers: false,
        departmentIds: 'all',
      });
      await deliverSiteEvents();

      const warm = await portalGet('/en');
      expect(warm.statusCode).toBe(200);
      expect(warm.body).not.toContain('/sign-in');
      // A second read is the cached page.
      expect((await portalGet('/en')).body).not.toContain('/sign-in');

      await call('PUT', portalSettingsPath(), ada, {
        enabled: true,
        newCustomers: false,
        departmentIds: 'all',
      });
      expect(await deliverSiteEvents()).toBeGreaterThan(0);

      expect((await portalGet('/en')).body).toContain('/sign-in');
    });
  });

  describe('account visibility and managers', () => {
    it('reads the members with their address and last portal use', async () => {
      const cookie = await cookieFor('mona');
      await portalGet('/tickets', cookie);

      const response = await call<AccountPortal>('GET', accountPath(acme), ada);
      expect(response.status).toBe(200);
      expect(response.body.visibility).toBe('own');
      expect(response.body.members.map((member) => member.name)).toEqual(['mona', 'omar']);
      const mona = response.body.members.find((member) => member.name === 'mona');
      expect(mona).toMatchObject({ email: 'mona@example.com', role: 'member' });
      expect(mona?.lastSignInAt).toEqual(expect.any(String));
      expect(
        response.body.members.find((member) => member.name === 'omar')?.lastSignInAt,
      ).toBeNull();
    });

    it('refuses a Viewer, a non-member contact, another brand, and an account of another brand', async () => {
      const body = { visibility: 'managers', managerContactIds: [who.mona] };
      expect((await call('PUT', accountPath(acme), vera, body)).status).toBe(403);
      expect(
        (
          await call('PUT', accountPath(acme), ada, {
            visibility: 'managers',
            managerContactIds: [who.lena],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call('PUT', accountPath(acme), ada, {
            visibility: 'managers',
            managerContactIds: [who.monaB],
          })
        ).status,
      ).toBe(400);
      expect([403, 404]).toContain((await call('PUT', accountPath(acme), olaB, body)).status);
      expect((await call('PUT', accountPath(acmeB), ada, body)).status).toBe(404);
      expect((await call('GET', accountPath(acmeB), ada)).status).toBe(404);

      const stored = await call<AccountPortal>('GET', accountPath(acme), ada);
      expect(stored.body.visibility).toBe('own');
    });

    it('changes what a signed-in member sees on the next request, with no new sign-in', async () => {
      const monaCookie = await cookieFor('mona');
      const omarCookie = await cookieFor('omar');
      const ours = (key: string) => refs[key] ?? '';

      // Own tickets: Mona sees hers only.
      expect(await listFor(monaCookie)).toEqual([ours('monaTicket')]);

      // Managers, with Mona as the manager: she sees Omar's, Omar still sees his own.
      const managers = await call<AccountPortal>('PUT', accountPath(acme), ada, {
        visibility: 'managers',
        managerContactIds: [who.mona],
      });
      expect(managers.status).toBe(200);
      expect(managers.body.members.find((member) => member.name === 'mona')?.role).toBe('manager');
      expect(await listFor(monaCookie)).toEqual(
        expect.arrayContaining([ours('monaTicket'), ours('omarTicket')]),
      );
      expect(await listFor(omarCookie)).not.toContain(ours('monaTicket'));
      expect(await listFor(omarCookie)).toContain(ours('omarTicket'));

      // Everyone: Omar now sees Mona's too.
      await call('PUT', accountPath(acme), ada, { visibility: 'all', managerContactIds: [] });
      expect(await listFor(omarCookie)).toEqual(
        expect.arrayContaining([ours('monaTicket'), ours('omarTicket')]),
      );
      const roles = await call<AccountPortal>('GET', accountPath(acme), ada);
      expect(roles.body.members.map((member) => member.role)).toEqual(['member', 'member']);

      // Back to own.
      await call('PUT', accountPath(acme), ada, { visibility: 'own', managerContactIds: [] });
      expect(await listFor(omarCookie)).not.toContain(ours('monaTicket'));
      expect(await listFor(omarCookie)).toContain(ours('omarTicket'));
    });

    it('audits the visibility change and the managers added and removed', async () => {
      const rows = await auditRows('account.portal.updated');
      expect(rows.map((row) => row.meta)).toEqual([
        {
          before: { visibility: 'own' },
          after: { visibility: 'managers' },
          managersAdded: [who.mona],
          managersRemoved: [],
        },
        {
          before: { visibility: 'managers' },
          after: { visibility: 'all' },
          managersAdded: [],
          managersRemoved: [who.mona],
        },
        {
          before: { visibility: 'all' },
          after: { visibility: 'own' },
          managersAdded: [],
          managersRemoved: [],
        },
      ]);
      expect(rows.every((row) => row.targetId === acme && row.actorId === ada.id)).toBe(true);
    });
  });

  describe('a contact’s portal access', () => {
    it('describes what the contact sees and why, and carries no token hash', async () => {
      await call('PUT', accountPath(acme), ada, {
        visibility: 'managers',
        managerContactIds: [who.mona],
      });
      const cookie = await cookieFor('mona');
      await portalGet('/tickets', cookie);

      const response = await call<ContactPortalAccess>('GET', contactPath('mona'), ada);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        signedIn: true,
        signsInWith: 'mona@example.com',
        sees: 'account',
        seesBecause: 'manager',
      });
      expect(response.body.sessions[0]).toEqual({
        id: expect.any(String),
        userAgentFamily: 'Firefox on Linux',
        lastSeenAt: expect.any(String),
        host: HOST_A,
      });

      const hashes = await owner.db
        .select({ tokenHash: customerSessions.tokenHash })
        .from(customerSessions);
      expect(hashes.length).toBeGreaterThan(0);
      for (const { tokenHash } of hashes) {
        expect(response.raw).not.toContain(tokenHash);
      }
      expect(response.raw.toLowerCase()).not.toContain('token');
      expect(response.raw).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);

      const omar = await call<ContactPortalAccess>('GET', contactPath('omar'), ada);
      expect(omar.body).toMatchObject({ seesBecause: 'member-not-manager', sees: 'own' });
      const lena = await call<ContactPortalAccess>('GET', contactPath('lena'), ada);
      expect(lena.body).toEqual({
        signedIn: false,
        signsInWith: null,
        sees: 'own',
        seesBecause: 'no-account',
        sessions: [],
      });
      await call('PUT', accountPath(acme), ada, { visibility: 'own', managerContactIds: [] });
    });

    it('refuses another brand’s contact, and lets a Viewer read but not sign out', async () => {
      expect((await call('GET', contactPath('monaB'), ada)).status).toBe(404);
      expect((await call('POST', `${contactPath('monaB')}/sign-out`, ada)).status).toBe(404);
      expect([403, 404]).toContain((await call('GET', contactPath('mona'), olaB)).status);
      expect((await call('GET', contactPath('mona'), vera)).status).toBe(200);
      expect((await call('POST', `${contactPath('mona')}/sign-out`, vera)).status).toBe(403);
    });

    it('signs the contact out everywhere: their sessions go and their next request is sent to sign in', async () => {
      const first = await cookieFor('mona');
      await cookieFor('mona');
      expect(await listFor(first)).not.toBe('sign-in');

      const response = await call<{ ended: number }>(
        'POST',
        `${contactPath('mona')}/sign-out`,
        ada,
      );
      expect(response.status).toBe(200);
      expect(response.body.ended).toBeGreaterThanOrEqual(2);

      expect(await listFor(first)).toBe('sign-in');
      const after = await call<ContactPortalAccess>('GET', contactPath('mona'), ada);
      expect(after.body).toMatchObject({ signedIn: false, signsInWith: null, sessions: [] });

      const rows = await auditRows('contact.portal.signed_out');
      expect(rows.at(-1)?.meta).toEqual({ sessionsEnded: response.body.ended });
      expect(JSON.stringify(rows.at(-1))).not.toMatch(/[0-9a-f]{64}/);

      // Another contact's sessions are untouched.
      const omar = await cookieFor('omar');
      await call('POST', `${contactPath('mona')}/sign-out`, ada);
      expect(await listFor(omar)).not.toBe('sign-in');
    });
  });

  describe('the private mark', () => {
    it('refuses a Viewer, and an agent of another department the way every ticket write does', async () => {
      expect((await call('PUT', privatePath('hrTicket'), vera, { private: true })).status).toBe(
        403,
      );
      expect((await call('PUT', privatePath('hrTicket'), sam, { private: true })).status).toBe(404);
      expect((await call('PUT', privatePath('omarTicket'), hana, { private: true })).status).toBe(
        404,
      );
      expect([403, 404]).toContain(
        (await call('PUT', privatePath('omarTicket'), olaB, { private: true })).status,
      );
      expect((await call('PUT', privatePath('omarTicket'), ada, { private: 'yes' })).status).toBe(
        400,
      );
      const [row] = await owner.db
        .select({ portalPrivate: tickets.portalPrivate })
        .from(tickets)
        .where(eq(tickets.id, t.hrTicket ?? ''));
      expect(row?.portalPrivate).toBe(false);
    });

    it('sets the mark, writes the activity line and an audit row, and says who now sees it', async () => {
      await call('PUT', accountPath(acme), ada, { visibility: 'all', managerContactIds: [] });
      const detailBefore = await call<TicketDetail>(
        'GET',
        `/api/brands/${brandA()}/tickets/${t.omarTicket ?? ''}`,
        ada,
      );
      expect(detailBefore.body.portal).toEqual({
        private: false,
        requester: 'omar',
        company: { name: 'Acme Trading', audience: 'all' },
      });

      const response = await call<TicketPortalView>('PUT', privatePath('omarTicket'), sam, {
        private: true,
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ private: true, requester: 'omar', company: null });

      const [stored] = await owner.db
        .select({ portalPrivate: tickets.portalPrivate })
        .from(tickets)
        .where(eq(tickets.id, t.omarTicket ?? ''));
      expect(stored?.portalPrivate).toBe(true);

      const activity = await owner.db
        .select()
        .from(ticketActivity)
        .where(
          and(
            eq(ticketActivity.ticketId, t.omarTicket ?? ''),
            eq(ticketActivity.action, 'ticket.portal_private.changed'),
          ),
        );
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        actorId: sam.id,
        from: { private: false },
        to: { private: true },
      });

      const audited = await auditRows('ticket.portal_private.changed');
      expect(audited.at(-1)).toMatchObject({
        targetId: t.omarTicket,
        actorId: sam.id,
        meta: { before: { private: false }, after: { private: true } },
      });

      const detail = await call<TicketDetail>(
        'GET',
        `/api/brands/${brandA()}/tickets/${t.omarTicket ?? ''}`,
        ada,
      );
      expect(detail.body.portal).toEqual({ private: true, requester: 'omar', company: null });

      // The same value again writes nothing.
      await call('PUT', privatePath('omarTicket'), sam, { private: true });
      expect(await auditRows('ticket.portal_private.changed')).toHaveLength(audited.length);
    });

    it('takes the ticket away from a coworker under "all members", and gives it back when unmarked', async () => {
      const monaCookie = await cookieFor('mona');
      const omarCookie = await cookieFor('omar');
      expect(await listFor(monaCookie)).not.toContain(refs.omarTicket);
      expect(await listFor(omarCookie)).toContain(refs.omarTicket);

      await call('PUT', privatePath('omarTicket'), sam, { private: false });
      expect(await listFor(monaCookie)).toContain(refs.omarTicket);

      await call('PUT', privatePath('omarTicket'), sam, { private: true });
      expect(await listFor(monaCookie)).not.toContain(refs.omarTicket);
      await call('PUT', privatePath('omarTicket'), sam, { private: false });
      await call('PUT', accountPath(acme), ada, { visibility: 'own', managerContactIds: [] });
    });

    it('works inside the agent’s own department', async () => {
      const response = await call<TicketPortalView>('PUT', privatePath('hrTicket'), hana, {
        private: true,
      });
      expect(response.status).toBe(200);
      expect(response.body.private).toBe(true);
    });
  });

  describe('participants', () => {
    it('lists how each CC was added, and who added it', async () => {
      await withSystem(runtime.db, brandA(), (tx) =>
        tx.insert(ticketParticipants).values({
          brandId: brandA(),
          ticketId: t.lenaTicket ?? '',
          departmentId: supportId,
          contactId: who.omar ?? '',
          address: 'omar@example.com',
          source: 'email',
        }),
      );
      const before = await call<TicketParticipantList>(
        'GET',
        `/api/brands/${brandA()}/tickets/${t.lenaTicket ?? ''}/participants`,
        ada,
      );
      expect(before.body.ccs).toMatchObject([
        { source: 'email', addedByName: null, seesInPortal: false },
      ]);

      // Adding the same address by hand raises the mail CC to a staff CC.
      const raised = await call<TicketParticipantList>(
        'POST',
        `/api/brands/${brandA()}/tickets/${t.lenaTicket ?? ''}/participants`,
        ada,
        { email: 'omar@example.com' },
      );
      expect(raised.status).toBe(201);
      expect(raised.body.ccs).toHaveLength(1);
      expect(raised.body.ccs[0]).toMatchObject({
        source: 'agent',
        seesInPortal: true,
      });
      const [adaRow] = await owner.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, ada.id));
      expect(raised.body.ccs[0]?.addedByName).toBe(adaRow?.name);

      const [row] = await owner.db
        .select({ source: ticketParticipants.source })
        .from(ticketParticipants)
        .where(eq(ticketParticipants.ticketId, t.lenaTicket ?? ''));
      expect(row?.source).toBe('agent');
    });

    it('does not promise the portal for an address that is not a verified identity of the CC', async () => {
      const added = await call<TicketParticipantList>(
        'POST',
        `/api/brands/${brandA()}/tickets/${t.monaTicket ?? ''}/participants`,
        ada,
        { email: 'stranger@elsewhere.example' },
      );
      expect(added.status).toBe(201);
      expect(added.body.ccs[0]).toMatchObject({ source: 'agent', seesInPortal: false });
    });
  });
});
