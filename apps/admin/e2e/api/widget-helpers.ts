import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WidgetAccessUpdate, WidgetAppearance, WidgetSettings } from '@helpdock/schemas';
import type { APIResponse, Page } from '@playwright/test';
import { strings } from '../strings.js';

/**
 * What the widget specs against the real api share: the seeded account signed
 * in once (`admin-session.ts`, whose `admin` page the specs drive beside a
 * visitor), calling the admin api as it, and a customer's site to embed the
 * widget on.
 */

const t = strings('en');

export { expect, openAdmin, test } from './admin-session.js';

/**
 * The admin api, as the signed-in page's account. A fresh access token per
 * call, from the refresh cookie, so a brand created a moment ago is in its
 * claims.
 */
export const adminRequest = async (
  page: Page,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  data?: unknown,
): Promise<APIResponse> => {
  const refreshed = await page.request.post('/api/auth/refresh');
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  return page.request.fetch(path, {
    method,
    headers: { authorization: `Bearer ${accessToken}` },
    ...(data === undefined ? {} : { data }),
  });
};

/** {@link adminRequest}, answering the body of a 2xx and throwing on anything else. */
export const adminApi =
  (page: Page) =>
  async <T>(method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> => {
    const response = await adminRequest(page, method, path, data);
    if (!response.ok()) {
      throw new Error(
        `${method} ${path} answered ${String(response.status())}: ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  };

type AdminApi = ReturnType<typeof adminApi>;

/** Adds `origin` to the brand's allowed origins, keeping whatever another spec allowed. */
export const allowOrigin = async (
  api: AdminApi,
  brandId: string,
  origin: string,
): Promise<void> => {
  const { access } = await api<WidgetSettings>('GET', `/api/brands/${brandId}/widget/settings`);
  if (access === null) {
    throw new Error('the seeded account is not an Admin of this brand');
  }
  const { captchaSecret: _stamp, ...current } = access;
  const update: WidgetAccessUpdate = {
    ...current,
    allowedOrigins: [...new Set([...current.allowedOrigins, origin])],
  };
  await api('PUT', `/api/brands/${brandId}/widget/access`, update);
};

/** Changes some of the brand's Appearance card, keeping the rest. */
export const setAppearance = async (
  api: AdminApi,
  brandId: string,
  change: Partial<WidgetAppearance>,
): Promise<void> => {
  const { appearance } = await api<WidgetSettings>('GET', `/api/brands/${brandId}/widget/settings`);
  await api('PUT', `/api/brands/${brandId}/widget/appearance`, { ...appearance, ...change });
};

/** The tag Channels › Widget shows, pointing at the api that serves `widget.js`. */
export const embedTag = (apiOrigin: string, brandId: string): string =>
  `<script type="module" src="${apiOrigin}/widget.js" data-brand="${brandId}"></script>`;

export interface CustomerSite {
  readonly origin: string;
  close(): Promise<void>;
}

/** A customer's page on an origin of its own: a heading and the embed tag, nothing else. */
export const startCustomerSite = async (
  name: string,
  embed: () => string,
): Promise<CustomerSite> => {
  const site: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1>${embed()}</body></html>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));

  return {
    origin: `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        site.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

/** Answers the ticket in the admin's workspace, as an agent would. */
export const replyInWorkspace = async (page: Page, text: string): Promise<void> => {
  await page.getByRole('list', { name: t('tickets:thread.label') }).waitFor();
  await page.getByRole('textbox', { name: t('tickets:composer.bodyLabel') }).fill(text);
  await page.getByRole('button', { name: t('tickets:composer.send') }).click();
  await page
    .getByRole('status')
    .filter({ hasText: t('tickets:toast.replied') })
    .waitFor();
};
