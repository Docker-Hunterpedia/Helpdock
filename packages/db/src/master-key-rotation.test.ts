import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_COLUMNS,
  MasterKeyRotationError,
  NOT_ENVELOPE_COLUMNS,
} from './master-key-rotation.js';
import * as schema from './schema/index.js';

const SECRET_LOOKING = /secret|password|encrypt|token|credential|sealed/;
/** Timestamps, actors and counters about a secret, rather than the secret. */
const ABOUT_A_SECRET = /_(at|by|count|in|out)$/;

const schemaColumns = (): string[] =>
  Object.values(schema)
    .filter((value) => is(value, PgTable))
    .flatMap((table) =>
      Object.values(getTableColumns(table)).map(
        (column) => `${getTableName(table)}.${column.name}`,
      ),
    );

const named = (list: readonly { table: string; column: string }[]): string[] =>
  list.map(({ table, column }) => `${table}.${column}`);

describe('master key rotation coverage', () => {
  it('knows about every column whose name says it holds a secret', () => {
    const known = new Set([...named(ENVELOPE_COLUMNS), ...named(NOT_ENVELOPE_COLUMNS)]);
    const unknown = schemaColumns().filter((column) => {
      const name = column.split('.')[1] ?? '';
      return SECRET_LOOKING.test(name) && !ABOUT_A_SECRET.test(name) && !known.has(column);
    });

    expect(unknown, 'add each to ENVELOPE_COLUMNS or NOT_ENVELOPE_COLUMNS').toEqual([]);
  });

  it('names only columns that exist', () => {
    const columns = new Set(schemaColumns());

    for (const column of [...named(ENVELOPE_COLUMNS), ...named(NOT_ENVELOPE_COLUMNS)]) {
      expect(columns.has(column), column).toBe(true);
    }
  });
});

describe('MasterKeyRotationError', () => {
  it('names the places it could not read and says nothing was changed', () => {
    const error = new MasterKeyRotationError(['webhooks.secret', 'settings.value']);

    expect(error.places).toEqual(['webhooks.secret', 'settings.value']);
    expect(error.message).toContain('webhooks.secret, settings.value');
    expect(error.message).toContain('Nothing was changed');
  });
});
