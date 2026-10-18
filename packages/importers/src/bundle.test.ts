import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readImportBundle } from './bundle.js';
import { collectAsync } from './testing/collect.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/bundles/${name}.zip`, import.meta.url));

it('streams a complete bundle with original dates after its validated manifest', async () => {
  const events = await collectAsync(readImportBundle({ path: fixture('valid') }));
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: 'manifest', manifest: { counts: { ticket: 1 } } });
  expect(events[1]).toMatchObject({
    type: 'record',
    record: { entity: 'ticket', payload: { externalId: '42', createdAt: '2019-01-01T00:00:00Z' } },
  });
});

it.each(['missing-manifest', 'count-mismatch', 'duplicate', 'traversal', 'symlink'])(
  'refuses unsafe or incomplete %s bundles',
  async (name) => {
    await expect(collectAsync(readImportBundle({ path: fixture(name) }))).rejects.toThrow();
  },
);

it('refuses invalid UTF-8 in a manifest before accepting the bundle', async () => {
  await expect(
    collectAsync(readImportBundle({ path: fixture('invalid-encoding') })),
  ).rejects.toMatchObject({ code: 'invalid-encoding', file: 'manifest.json' });
});

it('retains an article file reference only when its bundled member exists', async () => {
  const events = await collectAsync(readImportBundle({ path: fixture('article-attachments') }));
  expect(events[1]).toMatchObject({
    type: 'record',
    record: {
      entity: 'article',
      payload: {
        attachments: [{ externalId: 'original-file', bundlePath: 'attachments/manual.pdf' }],
      },
    },
  });
  await expect(
    collectAsync(readImportBundle({ path: fixture('article-missing-attachment') })),
  ).rejects.toMatchObject({ code: 'invalid-bundle', file: 'article.ndjson' });
});

it('validates the public snapshot file set independently of working article attachments', async () => {
  const events = await collectAsync(readImportBundle({ path: fixture('article-two-copies') }));
  expect(events[1]).toMatchObject({
    type: 'record',
    record: {
      entity: 'article',
      payload: {
        attachments: [{ externalId: 'original-file' }],
        published: {
          bodyHtml: '<p>Published answer</p>',
          publishedAt: null,
          attachments: [{ externalId: 'published-file', bundlePath: 'attachments/public.pdf' }],
        },
      },
    },
  });
  await expect(
    collectAsync(readImportBundle({ path: fixture('article-missing-published-file') })),
  ).rejects.toMatchObject({ code: 'invalid-bundle', file: 'article.ndjson' });
});
