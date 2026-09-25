import { describe, expect, it } from 'vitest';
import { QUEUE_NAME_LIST, QUEUE_NAMES } from './queues.js';

describe('queue names', () => {
  it('is the list in ARCHITECTURE §13', () => {
    expect([...QUEUE_NAME_LIST].sort()).toEqual([
      'ai',
      'assignment',
      'inbound',
      'knowledge',
      'maintenance',
      'media',
      'notify',
      'outbound',
      'outbox',
      'rules',
      'sla',
      'webhooks',
    ]);
  });

  it('names every queue after its key, so a rename cannot desynchronise the two', () => {
    for (const [key, name] of Object.entries(QUEUE_NAMES)) {
      expect(name).toBe(key);
    }
  });
});
