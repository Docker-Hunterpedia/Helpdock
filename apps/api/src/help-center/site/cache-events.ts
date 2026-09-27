import { type OutboxDispatcher, type OutboxEventHandler, outboxEvents } from '@helpdock/jobs';
import {
  HC_ACCESS_CHANGED_EVENT,
  HC_ARTICLE_CHANGED_EVENT,
  HC_SITE_CHANGED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
} from '@helpdock/schemas';
import type { PageCache } from './page-cache.js';

/**
 * The page cache's subscription to the help center's events (M5-03, the
 * contract M5-09 wrote down): whatever changed, the brand's cached pages are
 * dropped. A publish reaches the home page, the category, the section, the
 * article and its neighbours' "Related"; a rename reaches every page's
 * navigation; the access mode and the theme reach everything. Dropping the
 * brand is one `INCR` (`page-cache.ts`), so there is nothing to gain from
 * working out which pages a change touched.
 *
 * Registered under its own subscriber name, beside the default handler that
 * the content module owns; a delivery is at least once, and a second drop is
 * harmless.
 */

export const PAGE_CACHE_SUBSCRIBER = 'help_center.page_cache';

export const HC_PAGE_EVENTS = [
  HC_ARTICLE_CHANGED_EVENT,
  HC_STRUCTURE_CHANGED_EVENT,
  HC_ACCESS_CHANGED_EVENT,
  HC_SITE_CHANGED_EVENT,
] as const;

export const createPageCacheHandler =
  (cache: Pick<PageCache, 'invalidate'>): OutboxEventHandler =>
  async ({ brandId, event, outboxId, log }) => {
    await cache.invalidate(brandId);
    log.info({ event, outboxId, brandId }, 'help center pages dropped from the cache');
  };

/** Called by the worker's start-up, after the content module's own handlers. */
export const registerPageCacheHandlers = (
  cache: Pick<PageCache, 'invalidate'>,
  dispatcher: Pick<OutboxDispatcher, 'register'> = outboxEvents,
): void => {
  const handler = createPageCacheHandler(cache);
  for (const event of HC_PAGE_EVENTS) {
    dispatcher.register(event, handler, PAGE_CACHE_SUBSCRIBER);
  }
};
