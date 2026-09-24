import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { GLOBAL_TABLES, TENANT_TABLES } from '../rls.js';
import * as schema from './index.js';

const tables = Object.values(schema).filter((value) => is(value, PgTable));

const byName = new Map<string, PgTable>(tables.map((table) => [getTableName(table), table]));

const tableNamed = (name: string): PgTable => {
  const table = byName.get(name);
  if (table === undefined) {
    throw new Error(`The schema has no table named ${name}`);
  }
  return table;
};

const configOf = (name: string) => getTableConfig(tableNamed(name));

const columnsOf = (name: string): readonly string[] =>
  Object.values(getTableColumns(tableNamed(name))).map((column) => column.name);

describe('the schema', () => {
  it('declares the tables shipped so far (ARCHITECTURE §5)', () => {
    expect([...byName.keys()].sort()).toEqual([
      'accounts',
      'attachments',
      'audit_log',
      'blocked_senders',
      'brand_domains',
      'brands',
      'contact_duplicate_suggestions',
      'contact_identities',
      'contact_notes',
      'contacts',
      'custom_field_defs',
      'departments',
      'job_receipts',
      'outbox',
      'settings',
      'tags',
      'team_members',
      'teams',
      'ticket_activity',
      'ticket_messages',
      'ticket_statuses',
      'ticket_tags',
      'ticket_templates',
      'tickets',
      'user_brand_roles',
      'users',
    ]);
  });

  it('classifies every table as tenant-scoped or global, and never as both', () => {
    const classified = [
      ...TENANT_TABLES.map((table) => table.name),
      ...GLOBAL_TABLES.map((table) => table.name),
    ].sort();

    // A new table that is neither fails here, before it can quietly ship
    // without a policy and without a negative test (DOMAIN-RULES §1.6).
    expect(classified).toEqual([...byName.keys()].sort());
  });

  it('gives every tenant table the brand_id the policies filter on', () => {
    for (const table of TENANT_TABLES) {
      expect(columnsOf(table.name)).toContain('brand_id');
    }
  });

  it('gives every department-scoped table the denormalised department_id', () => {
    for (const table of TENANT_TABLES.filter((candidate) => candidate.departmentScoped)) {
      expect(columnsOf(table.name)).toContain('department_id');
    }
  });

  it('stamps a UUIDv7 on every row that does not bring an id', () => {
    const generated = [...byName.values()]
      .map((table) => getTableColumns(table).id)
      .filter((column) => column !== undefined)
      .map((column) => String(column.defaultFn?.()));

    // Every table but three has a uuid primary key; `settings` is keyed by
    // `(key, brand_id)`, `job_receipts` by the consumer's idempotency key, and
    // `ticket_tags` by the pair it joins.
    expect(generated).toHaveLength(byName.size - 3);
    for (const id of generated) {
      expect(id[14]).toBe('7');
    }
  });
});

describe('the indexes and constraints', () => {
  it('makes an email unique whatever its case', () => {
    const index = configOf('users').indexes.find((entry) => entry.config.name?.includes('email'));

    expect(index?.config.unique).toBe(true);
  });

  it('keeps the relay index down to the unpublished backlog', () => {
    const index = configOf('outbox').indexes.find(
      (entry) => entry.config.name === 'outbox_unpublished_idx',
    );

    expect(index?.config.where).toBeDefined();
  });

  it('gives a user one role per brand', () => {
    const unique = configOf('user_brand_roles').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['user_id', 'brand_id']);
  });

  it('keeps a department name unique inside its brand', () => {
    const unique = configOf('departments').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['brand_id', 'name']);
  });

  it('keeps a status name unique inside its brand, so the picker has no twins', () => {
    const unique = configOf('ticket_statuses').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['brand_id', 'name']);
  });

  it('numbers tickets per brand and refuses a duplicate', () => {
    const unique = configOf('tickets').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['brand_id', 'number']);
  });

  it('carries the ticket list index set of PRD M1-15', () => {
    const names = configOf('tickets').indexes.map((entry) => entry.config.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'tickets_brand_department_status_updated_idx',
        'tickets_brand_assignee_idx',
        'tickets_search_idx',
      ]),
    );
  });

  it('derives the search vector rather than letting a writer forget it', () => {
    const search = configOf('tickets').columns.find((column) => column.name === 'search');

    expect(search?.generated?.type).toBe('always');
  });

  it('keeps the two cursor columns at the precision a cursor can carry', () => {
    // A cursor carries an ISO-8601 string, which `Date` cannot hold beyond
    // milliseconds. A microsecond column would be compared against a truncated
    // copy of itself and the list would loop or skip rows.
    for (const name of ['created_at', 'updated_at']) {
      const column = configOf('tickets').columns.find((entry) => entry.name === name);

      expect(column?.getSQLType()).toBe('timestamp (3) with time zone');
    }
  });

  it('makes seq unique per ticket, which is the backstop under the lock', () => {
    const index = configOf('ticket_messages').indexes.find(
      (entry) => entry.config.name === 'ticket_messages_ticket_seq_key',
    );

    expect(index?.config.unique).toBe(true);
  });

  it('dedupes a retried send on (ticket, client_id), over the rows that have one', () => {
    const index = configOf('ticket_messages').indexes.find(
      (entry) => entry.config.name === 'ticket_messages_ticket_client_key',
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => 'name' in column && column.name)).toEqual([
      'ticket_id',
      'client_id',
    ]);
    // Partial: most rows have no `client_id`, and a full index would carry them.
    expect(index?.config.where).toBeDefined();
  });

  it('dedupes an inbound message per brand and channel (DOMAIN-RULES §6)', () => {
    const index = configOf('ticket_messages').indexes.find(
      (entry) => entry.config.name === 'ticket_messages_external_key',
    );

    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => 'name' in column && column.name)).toEqual([
      'brand_id',
      'channel',
      'external_message_id',
    ]);
  });

  it('keeps a team name unique inside its department', () => {
    const unique = configOf('teams').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['department_id', 'name']);
  });

  it('puts somebody on a team once', () => {
    const unique = configOf('team_members').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['team_id', 'user_id']);
  });

  it('lets a department lose its default team without losing the department', () => {
    const foreignKey = configOf('departments').foreignKeys.find((entry) =>
      entry.reference().columns.some((column) => column.name === 'default_team_id'),
    );

    expect(foreignKey?.onDelete).toBe('set null');
  });

  it('keys a setting by key and scope together', () => {
    const primaryKey = configOf('settings').primaryKeys[0];

    expect(primaryKey?.columns.map((column) => column.name)).toEqual(['key', 'brand_id']);
  });

  it('lets a hostname belong to one brand only', () => {
    const domain = configOf('brand_domains').columns.find((column) => column.name === 'domain');

    expect(domain?.isUnique).toBe(true);
  });

  it('lets one brand claim a domain once, and another brand claim it too', () => {
    const unique = configOf('accounts').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['brand_id', 'domain']);
  });

  it('binds an identifier to one contact inside a brand', () => {
    const unique = configOf('contact_identities').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual(['brand_id', 'kind', 'value']);
  });

  it('suggests a pair of contacts once', () => {
    const unique = configOf('contact_duplicate_suggestions').uniqueConstraints[0];

    expect(unique?.columns.map((column) => column.name)).toEqual([
      'brand_id',
      'contact_id',
      'other_contact_id',
    ]);
  });

  it('reserves a brand prefix for good', () => {
    const prefix = configOf('brands').columns.find((column) => column.name === 'prefix');

    expect(prefix?.isUnique).toBe(true);
  });
});
