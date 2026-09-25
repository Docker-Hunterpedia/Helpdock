import type { CsatSubmitRequest, CsatSurveyView } from '@helpdock/schemas';
import type { CsatApi } from './api.js';

/**
 * The Feedback tab's "Preview" (M1-15 part 2): the rating page as a customer
 * sees it, filled with a sample and never with a real survey.
 *
 * It answers without a network call, so the preview holds no token, reads no
 * ticket, and a rating sent from it is drawn as sent and stored nowhere. The
 * sample is in the page's language because the page asks for it at the moment
 * it loads, after the language is known.
 *
 * `preview` cannot collide with a real link: every token the api issues is two
 * base64url halves joined by a dot (`CSAT_TOKEN_PATTERN`).
 */
export const CSAT_PREVIEW_TOKEN = 'preview';

export type CsatSample = Extract<CsatSurveyView, { state: 'open' }>;

export class PreviewCsatApi implements CsatApi {
  readonly #sample: () => CsatSample;

  constructor(sample: () => CsatSample) {
    this.#sample = sample;
  }

  async survey(): Promise<CsatSurveyView> {
    return this.#sample();
  }

  async rate(_token: string, request: CsatSubmitRequest): Promise<CsatSurveyView> {
    return { state: 'rated', brand: this.#sample().brand, rating: request.rating };
  }
}
