import type { UnsubscribeView } from '@helpdock/schemas';
import { unsubscribeViewSchema } from '@helpdock/schemas';
import { type UnsubscribeApi, UnsubscribeLinkError, type UnsubscribeLinkProblem } from './api.js';

/**
 * The real service. A plain `fetch` with `credentials: 'omit'` rather than the
 * admin's `HttpTransport`: that one carries and refreshes a staff session, and
 * this call must never send one. The token is the only credential.
 */

const problemFor = (status: number): UnsubscribeLinkProblem =>
  status === 404 || status === 400 ? 'not-found' : 'unavailable';

export class HttpUnsubscribeApi implements UnsubscribeApi {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(
    baseUrl = '/api/public/unsubscribe',
    fetcher: typeof fetch = (...args) => fetch(...args),
  ) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetcher;
  }

  view(token: string): Promise<UnsubscribeView> {
    return this.#request(token, { method: 'GET' });
  }

  unsubscribe(token: string): Promise<UnsubscribeView> {
    // RFC 8058 section 3.1: the same body a mail client's one-click POST sends.
    return this.#request(token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
  }

  async #request(token: string, init: RequestInit): Promise<UnsubscribeView> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/${encodeURIComponent(token)}`, {
        ...init,
        credentials: 'omit',
      });
    } catch {
      throw new UnsubscribeLinkError('unavailable');
    }

    if (!response.ok) {
      throw new UnsubscribeLinkError(problemFor(response.status));
    }

    return unsubscribeViewSchema.parse(await response.json());
  }
}
