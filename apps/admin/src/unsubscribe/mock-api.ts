import type { UnsubscribeView } from '@helpdock/schemas';
import { type UnsubscribeApi, UnsubscribeLinkError } from './api.js';

/**
 * The fixture behind the unsubscribe page in the mock Playwright projects and
 * the unit tests: one valid link (English), one valid link for an Arabic
 * account, and anything else, which is the one "invalid or expired" answer a
 * forged token gets. Tokens are the real shape, so the route's parsing is the
 * real parsing.
 */

const token = (payload: string, mac: string): string => `${payload.repeat(27)}.${mac.repeat(43)}`;

export const MOCK_UNSUBSCRIBE_TOKENS = {
  valid: token('A', 'o'),
  arabic: token('B', 'a'),
  expired: token('C', 'e'),
} as const;

export const MOCK_UNSUBSCRIBE_EMAIL = 'lina@helpdock.com';

export class MockUnsubscribeApi implements UnsubscribeApi {
  readonly #done = new Set<string>();
  /** How many times the unsubscribe was posted, for a test to read. */
  posts = 0;

  async view(tokenValue: string): Promise<UnsubscribeView> {
    return this.#view(tokenValue);
  }

  async unsubscribe(tokenValue: string): Promise<UnsubscribeView> {
    const view = this.#view(tokenValue);
    this.posts += 1;
    this.#done.add(tokenValue);

    return { state: 'done', locale: view.locale };
  }

  #view(tokenValue: string): UnsubscribeView {
    if (tokenValue === MOCK_UNSUBSCRIBE_TOKENS.valid) {
      return { state: 'confirm', email: MOCK_UNSUBSCRIBE_EMAIL, locale: 'en' };
    }
    if (tokenValue === MOCK_UNSUBSCRIBE_TOKENS.arabic) {
      return { state: 'confirm', email: MOCK_UNSUBSCRIBE_EMAIL, locale: 'ar' };
    }

    throw new UnsubscribeLinkError('not-found');
  }
}
