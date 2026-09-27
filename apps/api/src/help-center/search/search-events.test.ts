import type { Db } from '@helpdock/db';
import {
  createOutboxDispatcher,
  helpCenterPublishDueJob,
  helpCenterSearchReindexSweepJob,
} from '@helpdock/jobs';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
} from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { silentJobLogger } from '../../testing/media.js';
import {
  articleChangedHandler,
  brandChangedHandler,
  createSearchKnowledgeProcessor,
  registerSearchEventHandlers,
  SEARCH_SUBSCRIBER,
} from './search-events.js';

const brandA = '0192c3f0-0000-7000-8000-00000000000a';
const brandB = '0192c3f0-0000-7000-8000-00000000000b';

/** A `Db` whose one read is the list of active brands. */
const brandsDb = (ids: readonly string[]): Db =>
  ({
    select: () => ({ from: () => ({ where: async () => ids.map((id) => ({ id })) }) }),
  }) as unknown as Db;

describe('the search subscriber (M5-05)', () => {
  it('subscribes to the three help center events under its own name', () => {
    const register = vi.fn();

    registerSearchEventHandlers({ register });

    expect(register.mock.calls).toEqual([
      [HC_ARTICLE_CHANGED_EVENT, articleChangedHandler, SEARCH_SUBSCRIBER],
      [HC_STRUCTURE_CHANGED_EVENT, brandChangedHandler, SEARCH_SUBSCRIBER],
      [HC_ACCESS_CHANGED_EVENT, brandChangedHandler, SEARCH_SUBSCRIBER],
    ]);
  });

  it('sits beside the default handler of the event rather than replacing it', () => {
    const dispatcher = createOutboxDispatcher();
    dispatcher.register(HC_ARTICLE_CHANGED_EVENT, async () => {});

    expect(() => registerSearchEventHandlers(dispatcher)).not.toThrow();
    expect(dispatcher.events).toContain(HC_ACCESS_CHANGED_EVENT);
  });

  it('refuses an article event whose payload is not one', async () => {
    await expect(
      articleChangedHandler({
        outboxId: 'o-1',
        brandId: brandA,
        event: HC_ARTICLE_CHANGED_EVENT,
        payload: { articleId: 'not-a-uuid' },
        tx: {} as never,
        log: silentJobLogger,
      }),
    ).rejects.toThrow();
  });
});

describe('the search jobs of the knowledge queue', () => {
  it('fans the hourly sweep out to one reindex per active brand, keyed by the hour', async () => {
    const add = vi.fn(async () => {});
    const process = createSearchKnowledgeProcessor({
      db: brandsDb([brandA, brandB]),
      log: silentJobLogger,
      queue: { add },
      now: () => new Date('2026-10-01T06:42:00.000Z'),
    });

    await process({ name: helpCenterSearchReindexSweepJob.name } as Job);

    expect(add.mock.calls).toEqual([
      [
        { brandId: brandA, tick: '2026-10-01T06:00:00.000Z' },
        `help_center.search_reindex.${brandA}.${Date.parse('2026-10-01T06:00:00.000Z')}`,
      ],
      [
        { brandId: brandB, tick: '2026-10-01T06:00:00.000Z' },
        `help_center.search_reindex.${brandB}.${Date.parse('2026-10-01T06:00:00.000Z')}`,
      ],
    ]);
  });

  it('leaves every other job of the queue to its own processor', () => {
    const process = createSearchKnowledgeProcessor({
      db: brandsDb([]),
      log: silentJobLogger,
      queue: { add: async () => {} },
    });

    expect(process({ name: helpCenterPublishDueJob.name } as Job)).toBeNull();
  });
});
