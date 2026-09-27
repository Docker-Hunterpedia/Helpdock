import { brands, type Db } from '@helpdock/db';
import {
  createJobProcessor,
  type HelpCenterSearchReindexPayload,
  helpCenterSearchReindexJob,
  helpCenterSearchReindexJobId,
  helpCenterSearchReindexSweepJob,
  type JobLogger,
  type OutboxDispatcher,
  type OutboxEventHandler,
  outboxEvents,
} from '@helpdock/jobs';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
  hcArticleChangedPayloadSchema,
} from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { hourOf } from '../publish-due.job.js';
import { reindexArticles } from './search-index.js';

/**
 * How the search index keeps up with the help center (M5-05, DOMAIN-RULES §5:
 * "removes them from the sitemap and search index" within 60 seconds).
 *
 * ```
 * publish, unpublish, archive, make internal → outbox(help_center.article_changed)  (request transaction)
 * relay, about a second later                → outbox.event
 * the `search` subscriber                    → re-index that article               (the event's transaction)
 * structure or access changed                → re-index the brand                   (the event's transaction)
 * hourly                                     → help_center.search_reindex per brand  (the safety net)
 * ```
 *
 * The subscriber writes in the event's own brand transaction, so the index
 * moves a second or two after the commit, well inside the budget. A brand
 * re-index skips every row already current, so running it for a structure or
 * access change costs a scan of the brand's versions and no writes; neither
 * change alters an indexed text today, and running it keeps the promise that
 * every `help_center.*` event leaves the index current without having to know
 * which ones can.
 */

/** This module's name among the handlers of the `help_center.*` events. */
export const SEARCH_SUBSCRIBER = 'search';

export const articleChangedHandler: OutboxEventHandler = async ({
  tx,
  brandId,
  payload,
  event,
  outboxId,
  log,
}) => {
  const { articleId } = hcArticleChangedPayloadSchema.parse(payload);
  const counts = await reindexArticles(tx, [articleId]);
  log.info({ event, outboxId, brandId, articleId, ...counts }, 'help center search re-indexed');
};

export const brandChangedHandler: OutboxEventHandler = async ({
  tx,
  brandId,
  event,
  outboxId,
  log,
}) => {
  const counts = await reindexArticles(tx);
  log.info({ event, outboxId, brandId, ...counts }, 'help center search re-indexed');
};

/** Called by the worker's start-up, beside `registerHelpCenterEventHandlers`. */
export const registerSearchEventHandlers = (
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  dispatcher.register(HC_ARTICLE_CHANGED_EVENT, articleChangedHandler, SEARCH_SUBSCRIBER);
  dispatcher.register(HC_STRUCTURE_CHANGED_EVENT, brandChangedHandler, SEARCH_SUBSCRIBER);
  dispatcher.register(HC_ACCESS_CHANGED_EVENT, brandChangedHandler, SEARCH_SUBSCRIBER);
};

export interface SearchReindexQueue {
  add(payload: HelpCenterSearchReindexPayload, jobId: string): Promise<void>;
}

/** One `help_center.search_reindex` per active brand. `brands` is global and read for ids alone. */
export const sweepSearchReindex = async ({
  db,
  queue,
  now,
}: {
  readonly db: Db;
  readonly queue: SearchReindexQueue;
  readonly now: Date;
}): Promise<number> => {
  const active = await db.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));
  const tick = hourOf(now);
  for (const { id: brandId } of active) {
    const payload = { brandId, tick };
    await queue.add(payload, helpCenterSearchReindexJobId(payload));
  }
  return active.length;
};

/** The search jobs of the `knowledge` queue, by name; `null` for a job that is not one of them. */
export const createSearchKnowledgeProcessor = ({
  db,
  log,
  queue,
  now = () => new Date(),
}: {
  readonly db: Db;
  readonly log: JobLogger;
  readonly queue: SearchReindexQueue;
  readonly now?: () => Date;
}): ((job: Job) => Promise<void> | null) => {
  const reindex = createJobProcessor(
    helpCenterSearchReindexJob,
    async ({ payload, tx }) => {
      const counts = await reindexArticles(tx);
      log.info(
        { job: helpCenterSearchReindexJob.name, brandId: payload.brandId, ...counts },
        'help center search reconciled',
      );
    },
    { db, log },
  );

  return (job) => {
    switch (job.name) {
      case helpCenterSearchReindexJob.name:
        return reindex(job);
      case helpCenterSearchReindexSweepJob.name:
        return sweepSearchReindex({ db, queue, now: now() }).then((swept) => {
          log.info({ job: job.name, brands: swept }, 'help center search sweep');
        });
      default:
        return null;
    }
  };
};
