// M10-04 stand-in for M10-05's enqueueMetaProfile; the orchestrator keeps M10-05's at merge.
import type { DbTransaction } from '@helpdock/db';
import { describe, expect, it, vi } from 'vitest';
import { enqueueMetaProfile, metaProfileEventSchema } from './messenger-profile.js';

const outboxRows = vi.hoisted(() => [] as unknown[]);
vi.mock('@helpdock/jobs', () => ({
  enqueueOutbox: async (_tx: unknown, row: unknown) => {
    outboxRows.push(row);
    return 'outbox-id';
  },
}));

const profile = {
  conversationId: '01924f00-0000-7000-8000-0000000000d1',
  accountId: '01924f00-0000-7000-8000-0000000000b1',
  platform: 'messenger',
} as const;

describe('enqueueMetaProfile', () => {
  it('writes the request as a meta.profile outbox row of the brand', async () => {
    await enqueueMetaProfile({} as DbTransaction, 'brand-1', profile);

    expect(outboxRows).toEqual([{ brandId: 'brand-1', event: 'meta.profile', payload: profile }]);
  });

  it('refuses a request that names no conversation, before anything is written', async () => {
    outboxRows.length = 0;

    await expect(
      enqueueMetaProfile({} as DbTransaction, 'brand-1', { ...profile, conversationId: 'x' }),
    ).rejects.toThrow();
    expect(metaProfileEventSchema.safeParse({ ...profile, platform: 'telegram' }).success).toBe(
      false,
    );
    expect(outboxRows).toEqual([]);
  });
});
