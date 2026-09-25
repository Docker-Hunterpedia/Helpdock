import type { CsatBrand, CsatSubmitRequest, CsatSurveyView } from '@helpdock/schemas';
import { type CsatApi, CsatLinkError } from './api.js';

/**
 * The fixture behind the rating page in the mock Playwright projects and the
 * unit tests: one link that is open, one already used, one expired. Tokens are
 * the real shape, so the route's parsing is the real parsing.
 *
 * The open one answers `used` after its first rating, as the api does.
 */

const token = (ids: string, mac: string): string => `${ids.repeat(43)}.${mac.repeat(43)}`;

export const MOCK_CSAT_TOKENS = {
  open: token('A', 'o'),
  used: token('B', 'u'),
  expired: token('C', 'e'),
} as const;

export const MOCK_CSAT_BRAND: CsatBrand = { name: 'Helpdock', locale: 'en', accent: null };

export const MOCK_CSAT_TICKET = {
  reference: 'HD-1042',
  subject: 'Refund not received after 10 days',
} as const;

export class MockCsatApi implements CsatApi {
  readonly #rated = new Set<string>();

  async survey(token: string): Promise<CsatSurveyView> {
    return this.#view(token);
  }

  async rate(token: string, request: CsatSubmitRequest): Promise<CsatSurveyView> {
    const view = this.#view(token);
    if (view.state !== 'open') {
      return view;
    }

    this.#rated.add(token);

    return { state: 'rated', brand: MOCK_CSAT_BRAND, rating: request.rating };
  }

  #view(token: string): CsatSurveyView {
    if (token === MOCK_CSAT_TOKENS.open && !this.#rated.has(token)) {
      return { state: 'open', brand: MOCK_CSAT_BRAND, ticket: { ...MOCK_CSAT_TICKET } };
    }
    if (token === MOCK_CSAT_TOKENS.open || token === MOCK_CSAT_TOKENS.used) {
      return { state: 'used', brand: MOCK_CSAT_BRAND };
    }
    if (token === MOCK_CSAT_TOKENS.expired) {
      return { state: 'expired', brand: MOCK_CSAT_BRAND };
    }

    throw new CsatLinkError('not-found');
  }
}
