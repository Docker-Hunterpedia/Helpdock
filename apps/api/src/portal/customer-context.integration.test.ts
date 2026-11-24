import {
  APP_ROLE_NAME,
  accounts,
  brands,
  contactIdentities,
  contacts,
  createDb,
  type DbHandle,
  departments,
  runMigrations,
  ticketStatuses,
  tickets,
  uuidv7,
  withSystem,
} from '@helpdock/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable } from '../testing/docker-available.js';
import {
  CustomerContextError,
  loadCustomerScope,
  withCustomerContext,
} from './customer-context.js';

/**
 * M21-01. The portal reads who a customer is on every request and hands that to
 * the policies, so a staff change takes effect on the next request and a
 * customer's facts are never trusted from a cookie. The policies themselves are
 * proved in `packages/db/src/portal-isolation.integration.test.ts`; this proves
 * the read that feeds them.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';
const CONTAINER_STARTUP_MS = 120_000;

const hasDocker = await dockerAvailable();

if (!hasDocker) {
  process.stderr.write(
    'Skipping the customer context tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const BRAND = uuidv7();
const OTHER_BRAND = uuidv7();
const SUPPORT = uuidv7();
const HR = uuidv7();
const OPEN = uuidv7();
const ACME = uuidv7();
const BOSS = uuidv7();
const STAFFER = uuidv7();
const LONER = uuidv7();
const GONE = uuidv7();
const ERASED = uuidv7();
const FOREIGN = uuidv7();
const bossTicket = uuidv7();
const stafferTicket = uuidv7();
const hrTicket = uuidv7();

describe.skipIf(!hasDocker)('withCustomerContext', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;

  const setPortal = (portal: Record<string, unknown>) =>
    withSystem(app.db, BRAND, (tx) =>
      tx.update(brands).set({ settings: { portal } }).where(eq(brands.id, BRAND)),
    );

  const ticketIds = (contactId: string) =>
    withCustomerContext(app.db, { brandId: BRAND, contactId }, async (tx) =>
      (await tx.select({ id: tickets.id }).from(tickets)).map((row) => row.id).sort(),
    );

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations({
      migrationUrl: container.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });
    app = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${container.getHost()}:${container.getPort()}/${container.getDatabase()}`,
    });

    await app.db.insert(brands).values([
      { id: BRAND, name: 'Acme', prefix: 'ACME' },
      { id: OTHER_BRAND, name: 'Globex', prefix: 'GLOBEX' },
    ]);
    await withSystem(app.db, BRAND, async (tx) => {
      await tx.insert(departments).values([
        { id: SUPPORT, brandId: BRAND, name: 'Support' },
        { id: HR, brandId: BRAND, name: 'HR' },
      ]);
      await tx.insert(ticketStatuses).values({
        id: OPEN,
        brandId: BRAND,
        name: 'Open',
        systemState: 'open',
        isDefault: true,
        color: 'info',
      });
      await tx.insert(accounts).values({ id: ACME, brandId: BRAND, name: 'Acme GmbH' });
      await tx.insert(contacts).values([
        { id: BOSS, brandId: BRAND, name: 'Boss', accountId: ACME, accountRole: 'manager' },
        { id: STAFFER, brandId: BRAND, name: 'Staffer', accountId: ACME },
        { id: LONER, brandId: BRAND, name: 'Loner' },
        { id: GONE, brandId: BRAND, name: 'Gone', mergedIntoId: BOSS },
        { id: ERASED, brandId: BRAND, name: 'Erased', anonymisedAt: new Date() },
      ]);
      await tx.insert(contactIdentities).values(
        [BOSS, STAFFER, LONER].map((contactId, index) => ({
          brandId: BRAND,
          contactId,
          kind: 'email' as const,
          value: `person${index}@example.com`,
          verified: true,
          source: 'test',
        })),
      );
      const ticket = (id: string, contactId: string, departmentId = SUPPORT, number = 0) => ({
        id,
        brandId: BRAND,
        departmentId,
        number,
        prefix: 'T',
        subject: id,
        statusId: OPEN,
        channel: 'email' as const,
        contactId,
      });
      await tx
        .insert(tickets)
        .values([
          ticket(bossTicket, BOSS, SUPPORT, 1),
          ticket(stafferTicket, STAFFER, SUPPORT, 2),
          ticket(hrTicket, STAFFER, HR, 3),
        ]);
    });
    await withSystem(app.db, OTHER_BRAND, (tx) =>
      tx.insert(contacts).values({ id: FOREIGN, brandId: OTHER_BRAND, name: 'Foreign' }),
    );
    await setPortal({ enabled: true });
  }, CONTAINER_STARTUP_MS);

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  describe('loadCustomerScope', () => {
    const scopeOf = (contactId: string) => loadCustomerScope(app.db, { brandId: BRAND, contactId });
    const setVisibility = (portalVisibility: 'own' | 'managers' | 'all') =>
      withSystem(app.db, BRAND, (tx) =>
        tx.update(accounts).set({ portalVisibility }).where(eq(accounts.id, ACME)),
      );

    it('reads own for everyone under the default, and carries the account', async () => {
      await setVisibility('own');

      expect(await scopeOf(BOSS)).toMatchObject({
        sees: 'own',
        accountId: ACME,
        departmentIds: 'all',
      });
      expect(await scopeOf(STAFFER)).toMatchObject({ sees: 'own', accountId: ACME });
    });

    it('widens a manager alone under managers, and every member under all', async () => {
      await setVisibility('managers');
      expect((await scopeOf(BOSS)).sees).toBe('account');
      expect((await scopeOf(STAFFER)).sees).toBe('own');

      await setVisibility('all');
      expect((await scopeOf(BOSS)).sees).toBe('account');
      expect((await scopeOf(STAFFER)).sees).toBe('account');
    });

    it('reads own and no account for a contact with none, whatever the setting', async () => {
      await setVisibility('all');

      expect(await scopeOf(LONER)).toMatchObject({ sees: 'own', accountId: null });
    });

    it('takes a change of setting or of role on the next read', async () => {
      await setVisibility('managers');
      expect((await scopeOf(STAFFER)).sees).toBe('own');

      await withSystem(app.db, BRAND, (tx) =>
        tx.update(contacts).set({ accountRole: 'manager' }).where(eq(contacts.id, STAFFER)),
      );
      expect((await scopeOf(STAFFER)).sees).toBe('account');
      await withSystem(app.db, BRAND, (tx) =>
        tx.update(contacts).set({ accountRole: 'member' }).where(eq(contacts.id, STAFFER)),
      );
      expect((await scopeOf(STAFFER)).sees).toBe('own');
    });

    it('returns the departments the brand shows', async () => {
      await setPortal({ enabled: true, departmentIds: [SUPPORT] });

      expect((await scopeOf(BOSS)).departmentIds).toEqual([SUPPORT]);
      await setPortal({ enabled: true });
    });

    it.each([
      ['a contact that was merged away', GONE],
      ['a contact that was erased', ERASED],
      ['a contact of another brand', FOREIGN],
      ['a contact that does not exist', uuidv7()],
    ])('refuses %s', async (_name, contactId) => {
      await expect(scopeOf(contactId)).rejects.toMatchObject({
        name: 'CustomerContextError',
        reason: 'contact-unavailable',
      });
    });

    it('refuses everyone while the brand has the portal off, and again once it is back on', async () => {
      await setPortal({ enabled: false });
      await expect(scopeOf(BOSS)).rejects.toBeInstanceOf(CustomerContextError);
      await expect(scopeOf(BOSS)).rejects.toMatchObject({ reason: 'portal-disabled' });

      await setPortal({ enabled: true });
      expect((await scopeOf(BOSS)).contactId).toBe(BOSS);
    });

    it.each([
      ['in its deletion grace', { status: 'deleting' as const, deletedAt: new Date() }],
      ['soft-deleted', { status: 'active' as const, deletedAt: new Date() }],
      ['deleted', { status: 'deleted' as const, deletedAt: new Date() }],
    ])('refuses a brand %s, whatever its portal setting says', async (_name, values) => {
      await app.db.update(brands).set(values).where(eq(brands.id, BRAND));
      try {
        await expect(scopeOf(BOSS)).rejects.toMatchObject({ reason: 'brand-unavailable' });
      } finally {
        await app.db
          .update(brands)
          .set({ status: 'active', deletedAt: null })
          .where(eq(brands.id, BRAND));
      }
    });

    it('treats a brand whose settings are unreadable as having the portal off', async () => {
      await setPortal({ enabled: 'yes' });

      await expect(scopeOf(BOSS)).rejects.toMatchObject({ reason: 'portal-disabled' });
      await setPortal({ enabled: true });
    });
  });

  describe('withCustomerContext', () => {
    it('opens a transaction in which the policies see exactly what the facts say', async () => {
      await withSystem(app.db, BRAND, (tx) =>
        tx.update(accounts).set({ portalVisibility: 'own' }).where(eq(accounts.id, ACME)),
      );
      // Every department is shown by default, so Staffer's HR ticket is theirs too.
      expect(await ticketIds(STAFFER)).toEqual([stafferTicket, hrTicket].sort());
      expect(await ticketIds(BOSS)).toEqual([bossTicket]);

      await withSystem(app.db, BRAND, (tx) =>
        tx.update(accounts).set({ portalVisibility: 'managers' }).where(eq(accounts.id, ACME)),
      );
      expect(await ticketIds(BOSS)).toEqual([bossTicket, stafferTicket, hrTicket].sort());
      expect(await ticketIds(STAFFER)).toEqual([stafferTicket, hrTicket].sort());
    });

    it('hides a department the brand does not show, and shows it again when it does', async () => {
      await setPortal({ enabled: true, departmentIds: [SUPPORT] });
      expect(await ticketIds(STAFFER)).not.toContain(hrTicket);

      await setPortal({ enabled: true, departmentIds: [SUPPORT, HR] });
      expect(await ticketIds(STAFFER)).toContain(hrTicket);
      await setPortal({ enabled: true });
    });

    it('passes the facts to the callback', async () => {
      const scope = await withCustomerContext(
        app.db,
        { brandId: BRAND, contactId: BOSS },
        async (_tx, facts) => facts,
      );

      expect(scope).toMatchObject({ brandId: BRAND, contactId: BOSS, accountId: ACME });
    });

    it('opens nothing when the facts cannot be read', async () => {
      let ran = false;

      await expect(
        withCustomerContext(app.db, { brandId: BRAND, contactId: FOREIGN }, async () => {
          ran = true;
        }),
      ).rejects.toBeInstanceOf(CustomerContextError);
      expect(ran).toBe(false);
    });
  });
});
