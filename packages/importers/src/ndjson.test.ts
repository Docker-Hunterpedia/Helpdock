import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { readImportNdjson } from './ndjson.js';
import { collectAsync } from './testing/collect.js';

it('keeps UTF-8 split across chunks, accepts BOM/CRLF and reports physical line numbers', async () => {
  const encoded = Buffer.from(`\uFEFF${JSON.stringify({ externalId: 't', name: 'الدعم' })}\r\n\n`);
  const chunks = Array.from(encoded, (byte) => Buffer.from([byte]));
  const records = await collectAsync(
    readImportNdjson({ stream: Readable.from(chunks), entity: 'tag', file: 'tag.ndjson' }),
  );
  expect(records).toEqual([{ entity: 'tag', payload: { externalId: 't', name: 'الدعم' } }]);
  await expect(
    collectAsync(
      readImportNdjson({
        stream: Readable.from(['\n{broken}']),
        entity: 'tag',
        file: 'tag.ndjson',
      }),
    ),
  ).rejects.toMatchObject({ code: 'invalid-json', line: 2 });
});

it('refuses an oversized unterminated line before parsing it', async () => {
  const stream = Readable.from(Array.from({ length: 65 }, () => Buffer.alloc(65536, 0x61)));
  await expect(
    collectAsync(readImportNdjson({ stream, entity: 'tag', file: 'tag.ndjson' })),
  ).rejects.toMatchObject({ code: 'line-too-large', line: 1 });
  expect(stream.destroyed).toBe(true);
});

it.each([
  ['invalid continuation', Buffer.from([0xc3, 0x28])],
  ['truncated final character', Buffer.from([0xe2, 0x82])],
])('refuses %s instead of silently altering source history', async (_scenario, malformed) => {
  const stream = Readable.from([
    Buffer.from('{"externalId":"t","name":"'),
    malformed,
    ...(_scenario === 'invalid continuation' ? [Buffer.from('"}\n')] : []),
  ]);
  await expect(
    collectAsync(readImportNdjson({ stream, entity: 'tag', file: 'tag.ndjson' })),
  ).rejects.toMatchObject({ code: 'invalid-encoding', file: 'tag.ndjson' });
  expect(stream.destroyed).toBe(true);
});

it('refuses deeply nested custom JSON with a safe line error before schema traversal', async () => {
  const nested = `${'['.repeat(200)}0${']'.repeat(200)}`;
  const json = `{"externalId":"1","subject":"History","status":"open","ccEmails":[],"tags":[],"custom":{"nested":${nested}},"createdAt":"2020-01-01T00:00:00Z","updatedAt":"2020-01-01T00:00:00Z"}`;
  await expect(
    collectAsync(
      readImportNdjson({ stream: Readable.from([json]), entity: 'ticket', file: 'ticket.ndjson' }),
    ),
  ).rejects.toMatchObject({ code: 'invalid-json', line: 1 });
});
