import { describe, expect, it } from 'vitest';
import { hcImportedPayloadSchema } from './help-center.js';

describe('help center import events', () => {
  it('accepts only a bounded run reference, never credentials or embedded article lists', () => {
    const runId = '0192c3f0-0000-7000-8000-00000000000a';
    expect(hcImportedPayloadSchema.parse({ runId })).toEqual({ runId });
    for (const payload of [
      {},
      { runId: 'bad' },
      { runId, credentials: 'secret' },
      { runId, articleIds: [] },
    ]) {
      expect(hcImportedPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });
});
