import type { BlockedEvent } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
import { safeAiTransport } from './ai-http.js';

describe('safeAiTransport', () => {
  it('refuses a private address the operator did not allow, before connecting (DOMAIN-RULES §13)', async () => {
    const blocked: BlockedEvent[] = [];
    const transport = safeAiTransport([], (event) => blocked.push(event));

    await expect(
      transport('http://127.0.0.1:11434/v1/models', { method: 'GET', headers: {} }),
    ).rejects.toMatchObject({ name: 'SafeFetchError' });
    expect(blocked[0]?.address).toBe('127.0.0.1');
  });
});
