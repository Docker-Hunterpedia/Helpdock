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
