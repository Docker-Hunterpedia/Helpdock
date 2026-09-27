import type { DbTransaction } from '@helpdock/db';
import {
  createOutboxDispatcher,
  type HelpCenterMediaProcessPayload,
  type HelpCenterPublishDuePayload,
  helpCenterPublishDueJobId,
  silentLogger,
} from '@helpdock/jobs';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_MEDIA_UPLOADED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  createArticleChangedHandler,
  type HelpCenterQueues,
  PUBLISH_GRACE_MS,
  registerHelpCenterEventHandlers,
} from './events.js';

const BRAND = '0192a000-0000-7000-8000-000000000001';
const ARTICLE = '0192a000-0000-7000-8000-000000000002';
const MEDIA = '0192a000-0000-7000-8000-000000000003';

const recording = () => {
  const publishes: { payload: HelpCenterPublishDuePayload; jobId: string; delayMs: number }[] = [];
  const media: HelpCenterMediaProcessPayload[] = [];
  const queues: HelpCenterQueues = {
    addMediaProcess: async (payload) => {
      media.push(payload);
    },
    addPublishDue: async (payload, jobId, delayMs) => {
      publishes.push({ payload, jobId, delayMs });
    },
  };
  return { queues, publishes, media };
};

const context = (event: string, payload: Record<string, unknown>) => ({
  outboxId: '0192a000-0000-7000-8000-0000000000ff',
  brandId: BRAND,
  event,
  payload,
  tx: {} as DbTransaction,
  log: silentLogger,
});

describe('the help center outbox handlers', () => {
  it('adds a delayed publish for a scheduled version, a moment after its minute', async () => {
    const { queues, publishes } = recording();
    const now = new Date('2026-10-01T05:00:00.000Z');
    const handler = createArticleChangedHandler(queues, () => now);

    await handler(
      context(HC_ARTICLE_CHANGED_EVENT, {
        articleId: ARTICLE,
        locale: 'ar',
        change: 'scheduled',
        scheduledAt: '2026-10-01T06:00:00.000Z',
      }),
    );

    const payload = { brandId: BRAND, tick: '2026-10-01T06:00:00.000Z' };
    expect(publishes).toEqual([
      { payload, jobId: helpCenterPublishDueJobId(payload), delayMs: 3_600_000 + PUBLISH_GRACE_MS },
    ]);
  });

  it('adds nothing for any other change', async () => {
    const { queues, publishes } = recording();
    const handler = createArticleChangedHandler(queues);

    await handler(
      context(HC_ARTICLE_CHANGED_EVENT, { articleId: ARTICLE, locale: null, change: 'slug' }),
    );

    expect(publishes).toEqual([]);
  });

  it('refuses a payload that is not an article change', async () => {
    const handler = createArticleChangedHandler(recording().queues);

    await expect(handler(context(HC_ARTICLE_CHANGED_EVENT, { articleId: 'x' }))).rejects.toThrow();
  });

  it('registers all four events, and converts an uploaded image', async () => {
    const { queues, media } = recording();
    const dispatcher = createOutboxDispatcher();
    registerHelpCenterEventHandlers(queues, dispatcher);

    expect(dispatcher.events).toEqual(
      expect.arrayContaining([
        HC_ARTICLE_CHANGED_EVENT,
        HC_STRUCTURE_CHANGED_EVENT,
        HC_ACCESS_CHANGED_EVENT,
        HC_MEDIA_UPLOADED_EVENT,
      ]),
    );

    await dispatcher.dispatch(context(HC_MEDIA_UPLOADED_EVENT, { mediaId: MEDIA }));
    await dispatcher.dispatch(context(HC_STRUCTURE_CHANGED_EVENT, { kind: 'section', id: MEDIA }));
    await dispatcher.dispatch(context(HC_ACCESS_CHANGED_EVENT, { access: 'internal_only' }));
    expect(media).toEqual([{ brandId: BRAND, mediaId: MEDIA }]);
  });
});
