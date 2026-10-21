import type { UnsubscribeView } from '@helpdock/schemas';

/**
 * The public unsubscribe page's two calls (M14-11). No session: the signed
 * token in the path is the credential. `MockUnsubscribeApi` is the fixture the
 * unit tests and the mock Playwright projects run against;
 * `HttpUnsubscribeApi` is the real service.
 */
export interface UnsubscribeApi {
  /** What the confirmation shows. Changes nothing. */
  view(token: string): Promise<UnsubscribeView>;
  /** The unsubscribe itself, as a mail client's one-click POST does it. */
  unsubscribe(token: string): Promise<UnsubscribeView>;
}

/**
 * `not-found` covers a forged, mistyped, expired or foreign token alike, and
 * the page draws one screen for all of them: it never says whether an address
 * has an account. `unavailable` is the api being down or the address having
 * used its budget: "try again".
 */
export type UnsubscribeLinkProblem = 'not-found' | 'unavailable';

export class UnsubscribeLinkError extends Error {
  readonly problem: UnsubscribeLinkProblem;

  constructor(problem: UnsubscribeLinkProblem) {
    super(`unsubscribe: ${problem}`);
    this.name = 'UnsubscribeLinkError';
    this.problem = problem;
  }
}

export const isUnsubscribeLinkError = (error: unknown): error is UnsubscribeLinkError =>
  error instanceof UnsubscribeLinkError;
