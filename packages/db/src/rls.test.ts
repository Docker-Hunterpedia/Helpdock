import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  renderTenantPolicyMigration,
  SESSION_SETTINGS,
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

describe('the committed policy migration', () => {
  it('is what the generator produces from TENANT_TABLES', () => {
    const committed = readFileSync(
      new URL('../drizzle/0002_tenant_rls_policies.sql', import.meta.url),
      'utf8',
    );

    // Run `pnpm --filter @helpdock/db gen:rls` when this fails.
    expect(committed).toBe(renderTenantPolicyMigration());
  });
});
