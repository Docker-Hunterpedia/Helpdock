import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, type DbHandle, type DbTransaction } from './client.js';
import { runMigrations } from './migrate.js';
import { TENANT_TABLES } from './rls.js';
import { APP_ROLE_NAME } from './roles.js';
import {
  auditLog,
  brandDomains,
  brands,
  departments,
  outbox,
  settings,
  ticketActivity,
  ticketMessages,
  ticketStatuses,
  tickets,
  userBrandRoles,
  users,
} from './schema/index.js';
import { withSystem, withTenant } from './tenant.js';
import { uuidv7 } from './uuid.js';

/**
 * The negative suite DOMAIN-RULES §1.6 requires. Every tenant table is in it,
 * and `covers every tenant table` below fails when a new one is added to
 * `TENANT_TABLES` without being added here.
 */

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17';
const APP_ROLE_PASSWORD = 'app-role-password';

const hasDocker = await promisify(execFile)('docker', ['info', '--format', '{{.ServerVersion}}'], {
  timeout: 10_000,
}).then(
  () => true,
  () => false,
);

if (!hasDocker) {
  process.stderr.write(
    'Skipping the row-level security tests: Docker is not available. Start Docker and re-run `pnpm test:integration`.\n',
  );
}

const brandA = uuidv7();
const brandB = uuidv7();
const userId = uuidv7();

/**
 * Ids drawn per brand rather than generated inside the insert, so that a
 * fixture row can point at the row another fixture wrote — a ticket needs a
 * department and a status, and a message needs a ticket — while each table
 * still holds exactly one row per brand, which is what the assertions below
 * count on.
 */
const perBrand = (): Record<string, string> => ({ [brandA]: uuidv7(), [brandB]: uuidv7() });
const departmentId = perBrand();
const statusId = perBrand();
const ticketId = perBrand();

/** Unique per row for the columns that are unique inside a brand or a ticket. */
let sequence = 0;
const nextNumber = (): number => {
  sequence += 1;
  return sequence;
};

/**
 * One row per tenant table, written by the brand that owns it.
 *
 * The department-scoped tables — `tickets`, `ticket_messages`,
 * `ticket_activity` — are here for the *cross-brand* half of DOMAIN-RULES §1.6,
 * which is what this suite proves for every table alike. The same-brand,
 * other-department half needs two departments and two principals inside one
 * brand and is proved where those exist: `apps/api/src/tickets/tickets.integration.test.ts`,
 * at the HTTP layer and in raw SQL.
 */
const fixtures = [
  {
    name: 'user_brand_roles',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(userBrandRoles).values({ userId, brandId, role: 'agent' }),
  },
  {
    name: 'departments',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(departments).values({ id: departmentId[brandId], brandId, name: 'Support' }),
  },
  {
    name: 'brand_domains',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(brandDomains).values({
        brandId,
        // `domain` is unique across the install, so the fixture row of each
        // brand needs a hostname of its own.
        domain: `support.${brandId}.example`,
        kind: 'helpcenter',
        txtToken: 'helpdock-verification=seeded',
      }),
  },
  {
    name: 'settings',
    insert: (tx: DbTransaction, brandId: string) =>
      tx
        .insert(settings)
        .values({ key: 'smtp.host', brandId, value: '"smtp.example.com"', updatedBy: 'test' }),
  },
  {
    name: 'audit_log',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(auditLog).values({
        brandId,
        actorType: 'system',
        actorId: 'test',
        action: 'test.seeded',
        targetType: 'test',
      }),
  },
  {
    name: 'outbox',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(outbox).values({ brandId, event: 'test.seeded', payload: { seeded: true } }),
  },
  {
    name: 'ticket_statuses',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(ticketStatuses).values({
        id: statusId[brandId],
        brandId,
        name: 'Open',
        systemState: 'open',
        isDefault: true,
        color: 'info',
      }),
  },
  {
    name: 'tickets',
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(tickets).values({
        id: ticketId[brandId],
        brandId,
        departmentId: departmentId[brandId] ?? '',
        number: nextNumber(),
        prefix: 'T',
        subject: 'Seeded',
        statusId: statusId[brandId] ?? '',
        channel: 'manual',
      }),
  },
  {
    name: 'ticket_messages',
    // A child row of an invisible ticket is refused by the trigger before the
    // policy is ever consulted: it finds no parent, so there is no department
    // to denormalise. Refused earlier is still refused.
    refusal: /not visible in this transaction/i,
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(ticketMessages).values({
        brandId,
        ticketId: ticketId[brandId] ?? '',
        // Whatever is passed is overwritten by the trigger with the parent
        // ticket's department. A ticket this transaction cannot see leaves it
        // null and NOT NULL refuses the row, which is why the cross-brand
        // insert below fails even before the policy is consulted.
        departmentId: departmentId[brandId] ?? '',
        seq: nextNumber(),
        kind: 'public',
        authorType: 'staff',
        bodyHtml: '<p>seeded</p>',
        bodyText: 'seeded',
        channel: 'manual',
      }),
  },
  {
    name: 'ticket_activity',
    refusal: /not visible in this transaction/i,
    insert: (tx: DbTransaction, brandId: string) =>
      tx.insert(ticketActivity).values({
        brandId,
        ticketId: ticketId[brandId] ?? '',
        departmentId: departmentId[brandId] ?? '',
        actorType: 'system',
        actorId: 'test',
        action: 'ticket.created',
        via: 'system',
      }),
  },
] as const;

const brandIdsIn = async (tx: DbTransaction, table: string): Promise<string[]> => {
  const rows = await tx.execute<{ brand_id: string }>(
    sql`SELECT brand_id::text AS brand_id FROM ${sql.identifier(table)}`,
  );
  return [...rows].map((row) => row.brand_id);
};

describe.skipIf(!hasDocker)('row-level security', () => {
  let container: StartedPostgreSqlContainer;
  let app: DbHandle;
  let owner: DbHandle;
  let db: Db;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    await runMigrations({
      migrationUrl: container.getConnectionUri(),
      appRolePassword: APP_ROLE_PASSWORD,
      log: () => {},
    });

    const { host, port, database } = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
    };
    app = createDb({
      url: `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/${database}`,
    });
    owner = createDb({ url: container.getConnectionUri() });
    db = app.db;

    // `users` and `brands` are global tables, so they are seeded without a
    // tenant context; everything else is written by the brand that owns it.
    await db.insert(users).values({ id: userId, email: 'agent@example.com', name: 'Agent' });
    await db.insert(brands).values([
      { id: brandA, name: 'Acme', prefix: 'ACME' },
      { id: brandB, name: 'Globex', prefix: 'GLOBEX' },
    ]);

    for (const brandId of [brandA, brandB]) {
      await withSystem(db, brandId, async (tx) => {
        for (const fixture of fixtures) {
          await fixture.insert(tx, brandId);
        }
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await container?.stop();
  });

  it('covers every tenant table', () => {
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual(
      TENANT_TABLES.map((table) => table.name).sort(),
    );
  });

  describe.each(fixtures)('$name', ({ name, insert, ...fixture }) => {
    const refusal = 'refusal' in fixture ? fixture.refusal : /row-level security/i;
    it('shows brand A only its own rows', async () => {
      const visible = await withSystem(db, brandA, (tx) => brandIdsIn(tx, name));

      expect(visible).toEqual([brandA]);
    });

    it('hides brand B behind an IN subquery', async () => {
      const visible = await withSystem(db, brandA, async (tx) => {
        const rows = await tx.execute<{ brand_id: string }>(
          sql`SELECT brand_id::text AS brand_id FROM ${sql.identifier(name)}
              WHERE brand_id IN (SELECT id FROM brands)`,
        );
        return [...rows].map((row) => row.brand_id);
      });

      expect(visible).toEqual([brandA]);
    });

    it('hides brand B behind a join', async () => {
      const visible = await withSystem(db, brandA, async (tx) => {
        const rows = await tx.execute<{ brand_id: string }>(
          sql`SELECT t.brand_id::text AS brand_id FROM ${sql.identifier(name)} t
              JOIN brands b ON b.id = t.brand_id`,
        );
        return [...rows].map((row) => row.brand_id);
      });

      expect(visible).toEqual([brandA]);
    });

    it('refuses to insert a row for brand B', async () => {
      const rejection = await withSystem(db, brandA, (tx) => insert(tx, brandB)).then(
        () => undefined,
        (error: unknown) => error as { cause?: { message?: string } },
      );

      expect(rejection?.cause?.message).toMatch(refusal);
    });

    it('updates none of brand B rows', async () => {
      const updated = await withSystem(db, brandA, async (tx) => {
        const result = await tx.execute(
          sql`UPDATE ${sql.identifier(name)} SET brand_id = brand_id WHERE brand_id = ${brandB}::uuid`,
        );
        return result.count;
      });

      expect(updated).toBe(0);
    });

    it('refuses to move its own row into brand B', async () => {
      const rejection = await withSystem(db, brandA, (tx) =>
        tx.execute(
          sql`UPDATE ${sql.identifier(name)} SET brand_id = ${brandB}::uuid WHERE brand_id = ${brandA}::uuid`,
        ),
      ).then(
        () => undefined,
        (error: unknown) => error as { cause?: { message?: string } },
      );

      // WITH CHECK is what catches this; USING alone would let the row walk out.
      expect(rejection?.cause?.message).toMatch(/row-level security/i);
    });

    it('deletes none of brand B rows', async () => {
      const deleted = await withSystem(db, brandA, async (tx) => {
        const result = await tx.execute(
          sql`DELETE FROM ${sql.identifier(name)} WHERE brand_id = ${brandB}::uuid`,
        );
        return result.count;
      });

      expect(deleted).toBe(0);
      // And brand B still has its row.
      const survivors = await withSystem(db, brandB, (tx) => brandIdsIn(tx, name));
      expect(survivors).toEqual([brandB]);
    });

    it('shows nothing at all without a tenant context', async () => {
      const visible = await db.transaction((tx) => brandIdsIn(tx, name));

      expect(visible).toEqual([]);
    });

    it('has row security enabled and forced, so an owner is bound by it too', async () => {
      // A superuser bypasses policies whatever the table says, which is why the
      // container's own role cannot demonstrate this and why the boot check in
      // `assertRuntimeRoleIsSafe` refuses to serve as one.
      const [flags] = await owner.db.execute<{ enabled: boolean; forced: boolean }>(
        sql`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
            FROM pg_class WHERE oid = ${name}::regclass`,
      );

      expect(flags).toEqual({ enabled: true, forced: true });
    });

    it('has one policy per command', async () => {
      const rows = await owner.db.execute<{ cmd: string }>(
        sql`SELECT cmd FROM pg_policies WHERE tablename = ${name} ORDER BY cmd`,
      );

      expect([...rows].map((row) => row.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });
  });

  it('keeps a staff principal inside the brands it was given', async () => {
    const context = {
      brandIds: [brandA],
      departmentIds: 'all',
      principalType: 'staff',
      principalId: userId,
    } as const;

    const visible = await withTenant(db, context, (tx) => brandIdsIn(tx, 'user_brand_roles'));

    expect(visible).toEqual([brandA]);
  });

  it('lets a principal with both brands see both', async () => {
    const visible = await withTenant(
      db,
      {
        brandIds: [brandA, brandB],
        departmentIds: 'all',
        principalType: 'staff',
        principalId: userId,
      },
      (tx) => brandIdsIn(tx, 'outbox'),
    );

    expect(visible.sort()).toEqual([brandA, brandB].sort());
  });

  it('forgets the context when the transaction ends', async () => {
    await withSystem(db, brandA, (tx) => brandIdsIn(tx, 'outbox'));

    const [setting] = await db.execute<{ value: string }>(
      sql`SELECT current_setting('app.brand_ids', true) AS value`,
    );

    expect(setting?.value ?? '').toBe('');
  });

  it('does not let the runtime role turn row security off', async () => {
    const rejection = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL row_security = off`);
        return brandIdsIn(tx, 'outbox');
      })
      .then(
        () => undefined,
        (error: unknown) => error as { cause?: { message?: string } },
      );

    expect(rejection?.cause?.message).toMatch(/row-level security/i);
  });
});
