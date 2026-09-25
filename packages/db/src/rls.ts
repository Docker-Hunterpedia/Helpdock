/**
 * Row-level security is the second of the four enforcement layers in
 * DOMAIN-RULES §1.3, and the only one that still holds when a query is written
 * by hand or a guard is forgotten. Every tenant table gets the same four
 * policies from {@link tenantPolicies}, so there is one shape to review and one
 * place to change it.
 */

/** The `SET LOCAL` session settings the policies read (DOMAIN-RULES §1.3). */
export const SESSION_SETTINGS = {
  brandIds: 'app.brand_ids',
  departmentIds: 'app.department_ids',
  allDepartments: 'app.all_departments',
  principalType: 'app.principal_type',
  principalId: 'app.principal_id',
} as const;

export interface TenantTable {
  readonly name: string;
  /**
   * Ticket-scoped tables carry a denormalised `department_id` and additionally
   * enforce department scope, so policies never need a join (DOMAIN-RULES §1.3).
   */
  readonly departmentScoped: boolean;
}

/**
 * Every table under row-level security. Adding a tenant table means adding it
 * here, regenerating the policy migration with `pnpm --filter @helpdock/db
 * gen:rls`, and extending the negative suite in `rls.integration.test.ts`, which
 * fails until the new table appears in it (DOMAIN-RULES §1.6).
 */
export const TENANT_TABLES: readonly TenantTable[] = [
  { name: 'user_brand_roles', departmentScoped: false },
  { name: 'departments', departmentScoped: false },
  // Not department-scoped: §1.3 lists the six ticket-scoped tables and neither
  // of these is one. A Team Leader configuring their own departments is a
  // service-layer rule (`brands/department-scope.ts`), as it already is for
  // `departments` itself.
  { name: 'teams', departmentScoped: false },
  { name: 'team_members', departmentScoped: false },
  { name: 'brand_domains', departmentScoped: false },
  // Contacts and accounts are brand-scoped and never department-scoped
  // (DOMAIN-RULES §1.2): an Agent may open any contact in the brand, and it is
  // the timeline that withholds the tickets they may not read.
  { name: 'accounts', departmentScoped: false },
  { name: 'contacts', departmentScoped: false },
  { name: 'contact_identities', departmentScoped: false },
  { name: 'contact_notes', departmentScoped: false },
  { name: 'contact_duplicate_suggestions', departmentScoped: false },
  { name: 'settings', departmentScoped: false },
  { name: 'audit_log', departmentScoped: false },
  { name: 'outbox', departmentScoped: false },
  // A brand's retention windows (M1-14): configuration, read by the Admin's
  // form and by the brand's own nightly job, never by a department.
  { name: 'retention_settings', departmentScoped: false },
  // A brand's status list is not a ticket: an Agent has to read the name of the
  // status a ticket in their own department is in, and the list is the same
  // list for every department.
  { name: 'ticket_statuses', departmentScoped: false },
  // A brand's tag list and its custom field definitions are configuration, not
  // tickets: the same list in every department, and an Agent has to read the
  // name of a tag that is on a ticket of their own. What is department-scoped
  // is which tickets carry which tag, which is `ticket_tags` below.
  { name: 'tags', departmentScoped: false },
  { name: 'custom_field_defs', departmentScoped: false },
  // A template may name a department, but that is where a ticket made from it
  // is filed — not who may read it. The picker on the create screen shows every
  // template the brand has.
  { name: 'ticket_templates', departmentScoped: false },
  // M1-11. A sender is blocked from the brand, not from a queue: the inbound
  // gate runs before a ticket, and so before a department, exists.
  { name: 'blocked_senders', departmentScoped: false },
  // M1-07. A department's rotation and its agents' skills are configuration,
  // like `teams`: which department a Team Leader may edit is a service rule
  // (`brands/department-scope.ts`), not a ticket's department scope.
  { name: 'assignment_agents', departmentScoped: false },
  { name: 'assignment_skills', departmentScoped: false },
  { name: 'tickets', departmentScoped: true },
  { name: 'ticket_messages', departmentScoped: true },
  { name: 'ticket_activity', departmentScoped: true },
  // An attachment is a child of a ticket, so it is department-scoped like the
  // thread it hangs off. It is also what makes DOMAIN-RULES §4.5 structural: a
  // presigned URL is issued from a row, and a row in another department is not
  // a row this transaction can read.
  { name: 'attachments', departmentScoped: true },
  // DOMAIN-RULES §1.3 names `ticket_tags` among the six department-scoped
  // tables; `department_id` is denormalised from the parent by the same trigger
  // `ticket_messages` uses.
  { name: 'ticket_tags', departmentScoped: true },
  // M1-13. A merge record is about two contacts, and contacts are brand-scoped
  // (DOMAIN-RULES §1.2); a ticket's CCs are a child of the ticket and follow
  // its department like `ticket_tags`.
  { name: 'contact_merges', departmentScoped: false },
  { name: 'ticket_participants', departmentScoped: true },
  // M1-12. Both hang off a ticket and carry its department by the same
  // triggers; DOMAIN-RULES §1.3 names `csat_responses` among the six.
  { name: 'ticket_time_entries', departmentScoped: true },
  { name: 'csat_responses', departmentScoped: true },
  // M1-15 part 2 (ADR 0011). The words of a ticket are the ticket's, so they
  // follow its department by the same triggers as its other children.
  { name: 'ticket_search_tokens', departmentScoped: true },
];

/**
 * Tables that are deliberately not tenant-scoped, with the reason. A table is
 * on one of these two lists or it is a mistake.
 */
export const GLOBAL_TABLES: readonly { readonly name: string; readonly reason: string }[] = [
  { name: 'users', reason: 'sign-in happens before any brand is known' },
  { name: 'brands', reason: 'the tenant itself, managed by audited install-admin paths' },
  { name: 'job_receipts', reason: 'claimed by a worker before it opens a brand transaction' },
];

// A policy body is assembled as text, so anything interpolated into it has to be
// an identifier we recognise rather than a caller's string.
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const assertIdentifier = (value: string): string => {
  if (!IDENTIFIER.test(value)) {
    throw new TypeError(`${value} is not a valid unquoted SQL identifier`);
  }
  return value;
};

/** `nullif(…, '')` so that an unset or empty setting is null and the policy denies. */
const uuidArraySetting = (name: string): string =>
  `nullif(current_setting('${name}', true), '')::uuid[]`;

const booleanSetting = (name: string): string =>
  `coalesce(nullif(current_setting('${name}', true), '')::boolean, false)`;

/**
 * The predicate every policy on a tenant table uses. Without a tenant context
 * the setting is null, `= ANY(null)` is null, and the row is invisible: the
 * failure mode is "nothing", never "everything".
 */
export const tenantPredicate = ({ name, departmentScoped }: TenantTable): string => {
  assertIdentifier(name);
  const brand = `brand_id = ANY (${uuidArraySetting(SESSION_SETTINGS.brandIds)})`;
  if (!departmentScoped) {
    return brand;
  }

  const department = `${booleanSetting(SESSION_SETTINGS.allDepartments)} OR department_id = ANY (${uuidArraySetting(SESSION_SETTINGS.departmentIds)})`;
  return `${brand}\n    AND (${department})`;
};

/**
 * The statements that put one table under row-level security: enable it, force
 * it so the table owner is bound by it too (DOMAIN-RULES §1.5), and one policy
 * per command. Returned as separate statements because a migration file runs
 * them one at a time.
 */
export const tenantPolicies = (
  name: string,
  { departmentScoped = false }: { readonly departmentScoped?: boolean } = {},
): readonly string[] => {
  const table = assertIdentifier(name);
  const predicate = tenantPredicate({ name: table, departmentScoped });

  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${table}_tenant_select" ON "${table}" FOR SELECT\n  USING (${predicate});`,
    `CREATE POLICY "${table}_tenant_insert" ON "${table}" FOR INSERT\n  WITH CHECK (${predicate});`,
    `CREATE POLICY "${table}_tenant_update" ON "${table}" FOR UPDATE\n  USING (${predicate})\n  WITH CHECK (${predicate});`,
    `CREATE POLICY "${table}_tenant_delete" ON "${table}" FOR DELETE\n  USING (${predicate});`,
  ];
};

/** Separator drizzle-kit writes between the statements of a migration file. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const MIGRATION_HEADER = `-- Generated by \`pnpm --filter @helpdock/db gen:rls\` from TENANT_TABLES in src/rls.ts.
-- Edit that list and regenerate; do not edit this file by hand.
--
-- Every tenant table of DOMAIN-RULES §1.3: row-level security enabled, forced so
-- the owner is bound by it too, and one policy per command reading the
-- \`app.*\` settings the request transaction sets.`;

/**
 * The policy block for `tables`, headed by the note that says where it came
 * from. It is appended to the migration that creates those tables, because
 * migrations are forward-only and a policy cannot precede its table.
 */
export const renderTenantPolicyStatements = (tables: readonly TenantTable[]): string => {
  const statements = tables.flatMap((table) =>
    tenantPolicies(table.name, { departmentScoped: table.departmentScoped }),
  );

  return `${STATEMENT_BREAKPOINT}\n${MIGRATION_HEADER}\n${statements.join(`\n${STATEMENT_BREAKPOINT}\n`)}\n`;
};

/**
 * The tenant tables whose policies `committedSql` — every migration committed
 * so far, concatenated — does not contain. An empty list is what both the
 * generator and `rls.test.ts` require: a tenant table with no policies is a
 * table row-level security does not cover (DOMAIN-RULES §1.6).
 */
export const missingPolicyTables = (
  committedSql: string,
  tables: readonly TenantTable[] = TENANT_TABLES,
): readonly TenantTable[] =>
  tables.filter((table) =>
    tenantPolicies(table.name, { departmentScoped: table.departmentScoped }).some(
      (statement) => !committedSql.includes(statement),
    ),
  );
