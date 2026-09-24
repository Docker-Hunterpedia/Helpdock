import type { CsatSubmitRequest, CsatSurveyView } from '@helpdock/schemas';
import { csatSurveyViewSchema } from '@helpdock/schemas';
import { type CsatApi, CsatLinkError, type CsatLinkProblem } from './api.js';

/**
 * The real service. A plain `fetch` rather than the admin's `HttpTransport`:
 * that one carries and refreshes a staff session, and this page must never
 * send one — a customer opening a link on a shared computer is not signed in as
 * whoever used it last.
 */

const problemFor = (status: number): CsatLinkProblem =>
  status === 404 || status === 400 ? 'not-found' : 'unavailable';

export class HttpCsatApi implements CsatApi {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl = '/api/public/csat', fetcher: typeof fetch = (...args) => fetch(...args)) {
    this.#baseUrl = baseUrl;
    this.#fetch = fetcher;
  }

  survey(token: string): Promise<CsatSurveyView> {
    return this.#request(token, { method: 'GET' });
  }

  rate(token: string, request: CsatSubmitRequest): Promise<CsatSurveyView> {
    return this.#request(token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  }

  async #request(token: string, init: RequestInit): Promise<CsatSurveyView> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/${encodeURIComponent(token)}`, {
        ...init,
        credentials: 'omit',
      });
    } catch {
      throw new CsatLinkError('unavailable');
    }

    if (!response.ok) {
      throw new CsatLinkError(problemFor(response.status));
    }

    return csatSurveyViewSchema.parse(await response.json());
  }
}
