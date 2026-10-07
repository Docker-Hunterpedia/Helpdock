import type { Db } from '@helpdock/db';
import { silentLogger } from '@helpdock/jobs';
import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { configureEmbeddingSpace, createEmbeddingSpaceProcessor } from './embedding-space.job.js';

/**
 * The routing and the "not configured" exit, without a database. What the
 * two jobs do to the space and the chunks is proved against a real Postgres
 * in `ai/ai.integration.test.ts`.
 */

const unreachable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('must not reach the database');
    },
  },
) as Db;

const settings = (values: Record<string, unknown>) => ({
  get: async (key: string) => values[key],
});

describe('the embedding space processor', () => {
  it('leaves every other job on the knowledge queue to the next processor', () => {
    const processor = createEmbeddingSpaceProcessor({
      db: unreachable,
      ai: { embed: async () => ({ vectors: [], model: 'm', dims: 1 }) },
      settings: settings({}) as never,
      queue: { add: async () => {} },
      log: silentLogger,
    });

    expect(processor({ name: 'help_center.publish_due', id: '1' } as Job)).toBeNull();
  });
});

describe('configureEmbeddingSpace', () => {
  it('does nothing, and reads no row, until a model and a dimension are set', async () => {
    const added: string[] = [];

    const outcome = await configureEmbeddingSpace({
      db: unreachable,
      settings: settings({
        'embedding.provider': '',
        'embedding.model': '',
        'embedding.dims': 0,
      }) as never,
      queue: { add: async (id) => void added.push(id) },
    });

    expect(outcome).toBe('unconfigured');
    expect(added).toEqual([]);
  });
});
