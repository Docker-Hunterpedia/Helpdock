import type { PageRenderer } from '@helpdock/ai';
import type { Browser, BrowserContext, Route } from 'playwright';

/**
 * "Render JavaScript" for a website crawl (M7-03, REQUIREMENTS §4.7:
 * "Playwright optional for JS sites"), behind `KNOWLEDGE_CRAWL_RENDER`.
 *
 * **The browser never opens a connection of its own.** Every request the page
 * makes is intercepted and answered by {@link RenderFetch}, which the worker
 * binds to the SSRF-safe client, so a page cannot reach a private address by
 * script that a plain fetch could not reach by URL (DOMAIN-RULES §13).
 * WebSockets and service workers, which interception does not cover, are
 * refused outright; images, media and fonts are not fetched at all, since only
 * the text is read.
 *
 * One headless Chromium per sync, one fresh context per page.
 */

export type RenderFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Buffer },
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}>;

export interface ClosableRenderer extends PageRenderer {
  close(): Promise<void>;
}

const SKIPPED_RESOURCES = new Set(['image', 'media', 'font']);
/** Long enough for a client-rendered page to settle, short enough for a crawl of hundreds. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** How one intercepted request is answered: through the safe client, or not at all. */
export const answerRoute = async (route: Route, fetchThrough: RenderFetch): Promise<void> => {
  const request = route.request();
  if (SKIPPED_RESOURCES.has(request.resourceType())) {
    await route.abort('blockedbyclient');
    return;
  }
  try {
    const body = request.postDataBuffer();
    const response = await fetchThrough(request.url(), {
      method: request.method(),
      headers: await request.allHeaders(),
      ...(body === null ? {} : { body }),
    });
    await route.fulfill({
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  } catch {
    await route.abort('blockedbyclient');
  }
};

export const createPlaywrightRenderer = async (
  fetchThrough: RenderFetch,
): Promise<ClosableRenderer> => {
  const { chromium } = await import('playwright');
  const browser: Browser = await chromium.launch({ headless: true });
  return {
    render: async (url) => {
      const context: BrowserContext = await browser.newContext({
        serviceWorkers: 'block',
        javaScriptEnabled: true,
      });
      try {
        await context.route('**/*', (route) => answerRoute(route, fetchThrough));
        await context.routeWebSocket(/.*/, (socket) => socket.close());
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });
        return { html: await page.content(), url: page.url() };
      } finally {
        await context.close();
      }
    },
    close: () => browser.close(),
  };
};
