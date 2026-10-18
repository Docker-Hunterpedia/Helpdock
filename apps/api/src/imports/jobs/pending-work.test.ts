import { describe, expect, it } from 'vitest';
import { markPendingImportWork } from './pending-work.js';

const brandId = '0192c3f0-0000-7000-8000-00000000000a';
const runId = '0192c3f0-0000-7000-8000-00000000000b';
const workId = '0192c3f0-0000-7000-8000-00000000000c';

describe('pending import work marker', () => {
  it.each([{ workId: 'not-an-outbox-id' }, { dueAt: 'tomorrow' }])(
    'refuses a malformed marker before touching the database: %j',
    async (bad) => {
      await expect(
        markPendingImportWork({} as never, {
          brandId,
          runId,
          workId,
          dueAt: new Date().toISOString(),
          ...bad,
        }),
      ).rejects.toMatchObject({ name: 'ZodError' });
    },
  );
});
