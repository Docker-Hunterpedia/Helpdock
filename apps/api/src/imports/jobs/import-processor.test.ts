import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { createImportProcessor } from './import-processor.js';

describe('import consumer queue boundary', () => {
  it.each(['import.load', 'import.dry_run'])(
    'refuses malformed %s payloads before resolving credentials or reading the database',
    async (name) => {
      const resolve = vi.fn(async () => {
        throw new Error('must not resolve');
      });
      const processor = createImportProcessor({ db: {} as never, storage: {} as never, resolve });
      await expect(
        processor({
          name,
          id: 'invalid',
          data: { brandId: 'bad', runId: 'bad', credentials: 'secret' },
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(resolve).not.toHaveBeenCalled();
    },
  );
  it('does not dispatch unknown queue jobs', async () => {
    const processor = createImportProcessor({
      db: {} as never,
      storage: {} as never,
      resolve: async () => {
        throw new Error('must not resolve');
      },
    });
    await expect(processor({ name: 'email.send', id: 'wrong-queue', data: {} })).rejects.toThrow(
      'import.unknown-job',
    );
  });
});
