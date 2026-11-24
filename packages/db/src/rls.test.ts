import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_TABLE_ACCESS,
  customerPolicies,
  missingCustomerPolicies,
  missingOwnerPolicies,
  missingPolicyTables,
  ownerPolicy,
  SESSION_SETTINGS,
  TENANT_TABLES,
  tenantPolicies,
  tenantPredicate,
} from './rls.js';

const policiesFor = (table: string, departmentScoped = false): string =>
  tenantPolicies(table, { departmentScoped }).join('\n');

describe('tenantPolicies', () => {
  it('enables and forces row-level security', () => {
    const sql = policiesFor('outbox');

    expect(sql).toContain('ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;');
  });

  it('writes one policy per command', () => {
    const statements = tenantPolicies('outbox');

    expect(statements.filter((statement) => statement.startsWith('CREATE POLICY'))).toHaveLength(4);
    for (const command of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(policiesFor('outbox')).toContain(`FOR ${command}`);
    }
  });

  it('checks the rows an insert or an update produces, not only the ones it reads', () => {
    const statements = tenantPolicies('outbox');
    const insert = statements.find((statement) => statement.includes('FOR INSERT')) ?? '';
    const update = statements.find((statement) => statement.includes('FOR UPDATE')) ?? '';

    expect(insert).toContain('WITH CHECK');
    // Without both, a row could be updated out of the brand it belongs to.
    expect(update).toContain('USING');
    expect(update).toContain('WITH CHECK');
  });

  it('reads the brand from the session setting the request transaction sets', () => {
    expect(policiesFor('outbox')).toContain(
      `brand_id = ANY (nullif(current_setting('${SESSION_SETTINGS.brandIds}', true), '')::uuid[])`,
    );
  });

  it('adds the department predicate only for a department-scoped table', () => {
    expect(policiesFor('outbox')).not.toContain(SESSION_SETTINGS.departmentIds);

    const scoped = policiesFor('ticket_messages', true);
    expect(scoped).toContain(
      `coalesce(nullif(current_setting('${SESSION_SETTINGS.allDepartments}', true), '')::boolean, false)`,
    );
    expect(scoped).toContain(
      `department_id = ANY (nullif(current_setting('${SESSION_SETTINGS.departmentIds}', true), '')::uuid[])`,
    );
  });

  it.each(['tickets; drop table users', 'public.tickets', 'Tickets', '', '1_tickets'])(
    'refuses %s as a table name',
    (name) => {
      expect(() => tenantPolicies(name)).toThrow(TypeError);
    },
  );
});

describe('tenantPredicate', () => {
  it('denies every row when the setting is missing, because ANY(null) is null', () => {
    // `nullif(…, '')` is what turns "no tenant context" into null rather than
    // into a cast error or an empty array comparison.
    expect(tenantPredicate({ name: 'outbox', departmentScoped: false })).toContain('nullif(');
  });

  it('lets a principal with every department through without listing them', () => {
    expect(tenantPredicate({ name: 'ticket_messages', departmentScoped: true })).toContain(
      'OR department_id = ANY',
    );
  });
});

describe('ownerPolicy', () => {
  it('is restrictive, so it narrows the brand policy rather than adding to it', () => {
    expect(ownerPolicy('views', 'owner_id')).toContain('AS RESTRICTIVE FOR ALL');
  });

  it('lets a shared row through and keeps a personal one for its owner', () => {
    expect(ownerPolicy('views', 'owner_id')).toContain(
      `owner_id IS NULL OR owner_id::text = current_setting('${SESSION_SETTINGS.principalId}', true)`,
    );
  });

  it('checks the rows a write produces too', () => {
    expect(ownerPolicy('views', 'owner_id')).toContain('WITH CHECK');
  });

  it('lets the system principal through only where the table asks for it', () => {
    const system = `current_setting('${SESSION_SETTINGS.principalType}', true) = 'system'`;

    expect(ownerPolicy('views', 'owner_id')).not.toContain(system);
    expect(ownerPolicy('notifications', 'user_id', { systemWrites: true })).toContain(
      `OR ${system}`,
    );
  });

  it('refuses a column that is not an identifier', () => {
    expect(() => ownerPolicy('views', 'owner_id; drop')).toThrow(TypeError);
  });
});

describe('customerPolicies (M21-01)', () => {
  const customerSetting = `current_setting('${SESSION_SETTINGS.principalType}', true)`;
  const policiesOf = (table: string): string => customerPolicies(table).join('\n');

  it('refuses the customer everything on a table that is not listed, with one restrictive policy', () => {
    const statements = customerPolicies('ticket_activity');

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('AS RESTRICTIVE FOR ALL');
    expect(statements[0]).toContain(
      `${customerSetting}) IN ('staff', 'visitor', 'apikey', 'system')`,
    );
    expect(statements[0]).toContain('WITH CHECK');
  });

  it('never grants anything: every statement is restrictive', () => {
    for (const { name } of TENANT_TABLES) {
      for (const statement of customerPolicies(name)) {
        expect(statement).toContain('AS RESTRICTIVE');
      }
    }
  });

  it('lets a customer read a ticket only as requester, CC or, in the company view, a non-private account ticket', () => {
    const read = policiesOf('tickets');

    expect(read).toContain('portal_eligible AND deleted_at IS NULL AND merged_into_id IS NULL');
    expect(read).toContain(
      `portal_contact_ids @> ARRAY[nullif(current_setting('${SESSION_SETTINGS.customerContactId}', true), '')::uuid]`,
    );
    expect(read).toContain(
      `current_setting('${SESSION_SETTINGS.customerSees}', true) = 'account' AND NOT portal_private`,
    );
    expect(read).toContain(
      `account_id = nullif(current_setting('${SESSION_SETTINGS.customerAccountId}', true), '')::uuid`,
    );
  });

  it('shows only public and AI messages, and only ready attachments', () => {
    expect(policiesOf('ticket_messages')).toContain("kind IN ('public', 'ai')");
    expect(policiesOf('attachments')).toContain("status = 'ready'");
  });

  it.each(['tickets', 'ticket_messages', 'attachments'])(
    'refuses a customer every write on %s, and passes every other principal through',
    (table) => {
      const statements = customerPolicies(table);
      for (const command of ['INSERT', 'UPDATE', 'DELETE']) {
        const policy = statements.find((statement) => statement.includes(`FOR ${command}`)) ?? '';
        expect(policy).toContain(`${customerSetting}) IN ('staff', 'visitor', 'apikey', 'system')`);
      }
    },
  );

  it('lets the system write sessions, lets staff and the owner read them, and nobody else', () => {
    const sessions = policiesOf('customer_sessions');

    expect(sessions).toContain(`${customerSetting} IN ('system', 'staff')`);
    expect(sessions).toContain(`${customerSetting} = 'customer' AND contact_id =`);
    for (const command of ['INSERT', 'UPDATE', 'DELETE']) {
      const policy =
        customerPolicies('customer_sessions').find((statement) =>
          statement.includes(`FOR ${command}`),
        ) ?? '';
      expect(policy).toContain(`${customerSetting} = 'system'`);
    }
  });

  it('leaves sign-in tokens to the system path, for reading as well as writing', () => {
    const [policy] = customerPolicies('customer_sign_in_tokens');

    expect(policy).toContain('FOR ALL');
    expect(policy).toContain(`USING (${customerSetting} = 'system')`);
  });

  it('lists only tables that are tenant tables', () => {
    const tenant = new Set(TENANT_TABLES.map((table) => table.name));

    expect(Object.keys(CUSTOMER_TABLE_ACCESS).filter((name) => !tenant.has(name))).toEqual([]);
  });

  it.each(['tickets; drop table users', 'Tickets', ''])('refuses %s as a table name', (name) => {
    expect(() => customerPolicies(name)).toThrow(TypeError);
  });
});

describe('the committed migrations', () => {
  const directory = new URL('../drizzle/', import.meta.url);
  const committed = readdirSync(directory)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => readFileSync(new URL(entry, directory), 'utf8'))
    .join('\n');

  it('puts every tenant table under the generated policies', () => {
    // Run `pnpm --filter @helpdock/db gen:rls` when this fails: it appends the
    // missing policies to the migration that creates the table.
    expect(missingPolicyTables(committed).map((table) => table.name)).toEqual([]);
  });

  it('puts every tenant table under a customer policy, so the principal reads nothing by default', () => {
    expect(missingCustomerPolicies(committed).map((table) => table.name)).toEqual([]);
  });

  it('puts every owner-scoped table under its owner policy', () => {
    expect(missingOwnerPolicies(committed)).toEqual([]);
  });

  it.each(TENANT_TABLES)('creates $name before the policies that reference it', ({ name }) => {
    const created = committed.indexOf(`CREATE TABLE "${name}"`);
    const enabled = committed.indexOf(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY;`);

    // Migrations are forward-only and run in file order, so a policy that
    // precedes its own table would fail on a fresh database.
    expect(created).toBeGreaterThanOrEqual(0);
    expect(enabled).toBeGreaterThan(created);
  });
});
