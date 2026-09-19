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
      'audit_log',
      'brand_domains',
      'brands',
      'contact_duplicate_suggestions',
      'contact_identities',
      'contact_notes',
      'contacts',
      'departments',
      'job_receipts',
      'outbox',
      'settings',
      'team_members',
      'teams',
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

    // Every table but two has a uuid primary key; `settings` is keyed by
    // `(key, brand_id)` and `job_receipts` by the consumer's idempotency key.
    expect(generated).toHaveLength(byName.size - 2);
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
