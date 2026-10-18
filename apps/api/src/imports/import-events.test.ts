import { describe, expect, it, vi } from 'vitest';
import { silentJobLogger } from '../testing/media.js';
import { createImportWorkHandler, enqueueImportWork } from './import-events.js';

const brandId = '0192c3f0-0000-7000-8000-00000000000a';
const runId = '0192c3f0-0000-7000-8000-00000000000b';

describe('import work event boundaries', () => {
  it.each([
    { step: 'unknown' },
    { notBefore: 'tomorrow' },
    { credentials: 'must-not-queue' },
    { runId: 'bad' },
  ])('refuses malformed producer requests before touching the database: %j', async (extra) => {
    await expect(
      enqueueImportWork({} as never, { brandId, runId, step: 'load', ...extra } as never),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
  it('refuses credential-bearing delivery payloads before adding a job', async () => {
    const add = vi.fn(async () => {});
    const handler = createImportWorkHandler({ add });
    await expect(
      handler({
        tx: {} as never,
        brandId,
        outboxId: runId,
        event: 'import.work_requested',
        payload: { runId, step: 'load', credentials: 'must-not-queue' },
        log: silentJobLogger,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(add).not.toHaveBeenCalled();
  });
});
