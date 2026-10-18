import { Readable } from 'node:stream';
import { type ImportFileMapping, importFileMappingSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { createFileRowMapper } from './file-mapper.js';
import { validateImportCsv } from './file-preview.js';
import { FileTransformError, transformFileValue } from './file-transforms.js';

const columns = ['Ticket ID', 'Subject', 'Created', 'Body'];
const mapping: ImportFileMapping = importFileMappingSchema.parse({
  entity: 'ticket',
  fields: [
    {
      target: 'externalId',
      source: { kind: 'columns', names: ['Ticket ID'] },
      transforms: [],
      omitEmpty: false,
    },
    {
      target: 'subject',
      source: { kind: 'columns', names: ['Subject'] },
      transforms: [],
      omitEmpty: false,
    },
    ...['createdAt', 'updatedAt'].map((target) => ({
      target,
      source: { kind: 'columns', names: ['Created'] },
      transforms: [{ kind: 'date', format: 'dmy', timezone: 'Asia/Riyadh' }],
      omitEmpty: false,
    })),
    {
      target: 'status',
      source: { kind: 'literal', value: 'Solved' },
      transforms: [],
      omitEmpty: false,
    },
  ],
  firstMessageFields: [
    {
      target: 'bodyText',
      source: { kind: 'columns', names: ['Body'] },
      transforms: [],
      omitEmpty: false,
    },
    {
      target: 'public',
      source: { kind: 'literal', value: true },
      transforms: [],
      omitEmpty: false,
    },
    {
      target: 'authorKind',
      source: { kind: 'literal', value: 'customer' },
      transforms: [],
      omitEmpty: false,
    },
    {
      target: 'authorExternalId',
      source: { kind: 'literal', value: 'customer-001' },
      transforms: [],
      omitEmpty: false,
    },
  ],
});

it('keeps original IDs, Arabic multiline history, author and explicit date interpretation', () => {
  const result = createFileRowMapper(
    mapping,
    columns,
  )(['0007', 'طلب قديم', '03/11/2024 14:20', 'مرحبًا\n"الرد الأصلي"']);
  expect(result).toMatchObject({
    ok: true,
    records: [
      {
        entity: 'ticket',
        payload: {
          externalId: '0007',
          subject: 'طلب قديم',
          status: 'Solved',
          createdAt: '2024-11-03T11:20:00.000Z',
          updatedAt: '2024-11-03T11:20:00.000Z',
        },
      },
      {
        entity: 'message',
        payload: {
          ticketExternalId: '0007',
          authorExternalId: 'customer-001',
          authorKind: 'customer',
          public: true,
          createdAt: '2024-11-03T11:20:00.000Z',
          bodyText: 'مرحبًا\n"الرد الأصلي"',
        },
      },
    ],
  });
  const again = createFileRowMapper(
    mapping,
    columns,
  )(['0007', 'طلب قديم', '03/11/2024 14:20', 'مرحبًا\n"الرد الأصلي"']);
  expect(again).toEqual(result);
});

it('validates rows beyond the twenty-row preview and counts omissions without treating them as valid', async () => {
  const rows = Array.from(
    { length: 125 },
    (_, index) => `${index},Subject,${index < 20 ? '03/11/2024 14:20' : '31/02/2024'},Body`,
  );
  const source = `${columns.join(',')}\n${rows.join('\n')}\n`;
  const result = await validateImportCsv({
    stream: Readable.from([source]),
    file: 'tickets.csv',
    mapping: { ...mapping, skipInvalidRows: true },
  });
  expect(result).toMatchObject({ checkedRows: 125, invalidRows: 105, records: 40 });
  expect(result.preview.rows).toHaveLength(20);
  expect(result.preview.rows.every((row) => row.result.ok)).toBe(true);
  expect(result.issues).toHaveLength(100);
  expect(result.issues[0]).toMatchObject({ line: 22, issue: { code: 'invalid-date' } });
});

it.each([
  ['01/02/2024', 'dmy', 'UTC', '2024-02-01T00:00:00.000Z'],
  ['01/02/2024', 'mdy', 'UTC', '2024-01-02T00:00:00.000Z'],
  ['0', 'epoch-seconds', 'UTC', '1970-01-01T00:00:00.000Z'],
] as const)(
  'interprets %s only with the explicit %s format',
  (value, format, timezone, expected) => {
    expect(transformFileValue(value, { kind: 'date', format, timezone })).toBe(expected);
  },
);

it.each([
  ['10/03/2024 02:30', 'America/New_York'],
  ['03/11/2024 01:30', 'America/New_York'],
  ['31/02/2024', 'UTC'],
] as const)('refuses impossible or ambiguous local date %s in %s', (value, timezone) => {
  expect(() => transformFileValue(value, { kind: 'date', format: 'dmy', timezone })).toThrow(
    FileTransformError,
  );
});

it.each(['', 'NaN', 'Infinity', '01', '0x10', '1e999', '1,500'])(
  'does not silently coerce numeric source value %j',
  (value) => {
    expect(() => transformFileValue(value, { kind: 'number' })).toThrow(FileTransformError);
  },
);

it('preserves structured field options and refuses excessively nested source JSON', () => {
  expect(transformFileValue('[{"value":"gold","label":"ذهبي"}]', { kind: 'json' })).toEqual([
    { value: 'gold', label: 'ذهبي' },
  ]);
  expect(transformFileValue(' -1.25e2 ', { kind: 'number' })).toBe(-125);
  expect(() => transformFileValue(`${'['.repeat(22)}0${']'.repeat(22)}`, { kind: 'json' })).toThrow(
    FileTransformError,
  );
  expect(() => transformFileValue('[1e999]', { kind: 'json' })).toThrow(FileTransformError);
});
