import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { collectAsync } from './testing/collect.js';
import { readTicketInventoryCsv } from './ticket-inventory-csv.js';

it('reads only the selected ID column, preserving numeric strings and source line provenance', async () => {
  const rows = await collectAsync(
    readTicketInventoryCsv({
      file: 'archive.csv',
      stream: Readable.from([
        'Ticket ID,Subject\n9007199254740993,Original issue\n0002,Another issue\n',
      ]),
      mapping: { idColumn: 'Ticket ID', location: 'archived' },
    }),
  );
  expect(rows).toEqual([
    { externalId: '9007199254740993', location: 'archived', line: 2 },
    { externalId: '0002', location: 'archived', line: 3 },
  ]);
});

it('streams duplicate IDs for durable deduplication without keeping a whole-file ID set', async () => {
  const rows = await collectAsync(
    readTicketInventoryCsv({
      file: 'inventory.csv',
      stream: Readable.from(['id;subject\n1;one\n1;duplicate\n']),
      mapping: { idColumn: 'id', location: 'auto' },
    }),
  );
  expect(rows.map((row) => row.externalId)).toEqual(['1', '1']);
});

it.each([null, 'Missing column'])(
  'closes the source when an inventory column is not selected or present: %s',
  async (idColumn) => {
    const stream = Readable.from(['id,subject\n1,Original\n']);
    await expect(
      collectAsync(
        readTicketInventoryCsv({
          stream,
          file: 'source.csv',
          mapping: { idColumn, location: 'auto' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-csv-header' });
    expect(stream.destroyed).toBe(true);
  },
);

it.each(['', ' ', 'identifier with spaces', 'invalid ID https://example.test'])(
  'refuses an unusable source ID without exposing the cell in diagnostics: %s',
  async (value) => {
    const stream = Readable.from([
      `id,subject\n${JSON.stringify(value).replace(/\\"/g, '""')},Original\n`,
    ]);
    const error = await collectAsync(
      readTicketInventoryCsv({
        stream,
        file: 'source.csv',
        mapping: { idColumn: 'id', location: 'active' },
      }),
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: 'ImportFileError' });
    expect(String(error)).not.toContain('example.test');
    expect(stream.destroyed).toBe(true);
  },
);

it('closes a partially consumed source when the worker stops reading', async () => {
  const stream = Readable.from(['id\n1\n2\n3\n']);
  const iterator = readTicketInventoryCsv({
    stream,
    file: 'source.csv',
    mapping: { idColumn: 'id', location: 'auto' },
  });
  expect((await iterator.next()).value).toMatchObject({ externalId: '1' });
  await iterator.return(undefined);
  expect(stream.destroyed).toBe(true);
});
