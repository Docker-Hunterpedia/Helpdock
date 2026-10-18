import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { readImportCsv } from './csv.js';
import { collectAsync } from './testing/collect.js';

it.each(['utf8', 'utf16le', 'utf16be'] as const)(
  'preserves Arabic and multiline history in byte-split %s files',
  async (encoding) => {
    const text = '\uFEFFid;body;date\r\n001;"مرحبا,\r\n""العالم""";31/12/2020\r\n';
    const bytes = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    expect(
      await collectAsync(
        readImportCsv({
          stream: Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))),
          file: 'history.csv',
        }),
      ),
    ).toEqual([
      { type: 'header', columns: ['id', 'body', 'date'], delimiter: ';' },
      { type: 'row', cells: ['001', 'مرحبا,\r\n"العالم"', '31/12/2020'], line: 3 },
    ]);
  },
);

it.each([',', '\t'] as const)(
  'detects %j without casting values or stripping spaces',
  async (delimiter) => {
    const text = `id${delimiter}name\n001${delimiter}  Name  \n`;
    expect(
      await collectAsync(readImportCsv({ stream: Readable.from([text]), file: 'contacts.csv' })),
    ).toEqual([
      { type: 'header', columns: ['id', 'name'], delimiter },
      { type: 'row', cells: ['001', '  Name  '], line: 2 },
    ]);
  },
);

it.each([
  ['duplicate headers', Buffer.from('id,id\n1,2'), 'invalid-csv-header'],
  ['empty header', Buffer.from('id,\n1,2'), 'invalid-csv-header'],
  ['empty file', Buffer.alloc(0), 'invalid-csv-header'],
  ['unequal width', Buffer.from('id,name\n1,Name,extra'), 'invalid-csv'],
  ['unfinished quote', Buffer.from('id,name\n1,"secret'), 'invalid-csv'],
  ['malformed UTF-8', Buffer.from([0x69, 0x64, 0x0a, 0xc3, 0x28]), 'invalid-encoding'],
  ['truncated UTF-16', Buffer.from([0xff, 0xfe, 0x69]), 'invalid-encoding'],
])(
  'refuses %s with a diagnostic that does not expose cell contents',
  async (_name, bytes, code) => {
    const stream = Readable.from([bytes]);
    const result = collectAsync(readImportCsv({ stream, file: 'input.csv' }));
    await expect(result).rejects.toMatchObject({ code, file: 'input.csv' });
    await expect(result).rejects.not.toThrow('secret');
    expect(stream.destroyed).toBe(true);
  },
);

it('bounds oversized records and closes a preview source on early return', async () => {
  const oversized = Readable.from(['id,body\n1,"', Buffer.alloc(4 * 1024 * 1024 + 1, 97)]);
  await expect(
    collectAsync(readImportCsv({ stream: oversized, file: 'large.csv' })),
  ).rejects.toMatchObject({ code: 'line-too-large' });
  expect(oversized.destroyed).toBe(true);
  const source = Readable.from(['id,name\n1,One\n2,Two\n']);
  for await (const event of readImportCsv({ stream: source, file: 'preview.csv' })) {
    if (event.type === 'row') break;
  }
  expect(source.destroyed).toBe(true);
});

it('aborts a blocked source without waiting for another chunk', async () => {
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  const result = collectAsync(
    readImportCsv({ stream, file: 'blocked.csv', signal: controller.signal }),
  );
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(stream.destroyed).toBe(true);
});
