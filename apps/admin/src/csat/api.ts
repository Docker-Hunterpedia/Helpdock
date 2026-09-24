import type { CsatSubmitRequest, CsatSurveyView } from '@helpdock/schemas';

/**
 * The public rating page's two calls (M1-12). No session: the token in the
 * path is the credential. `MockCsatApi` is the fixture the unit tests and the
 * mock Playwright projects run against; `HttpCsatApi` is the real service.
 */
export interface CsatApi {
  survey(token: string): Promise<CsatSurveyView>;
  rate(token: string, request: CsatSubmitRequest): Promise<CsatSurveyView>;
}

/**
 * Why a link could not be used at all. `not-found` covers a forged, mistyped
 * or foreign token, and the page draws it as a spent link: it says nothing
 * about whether a survey exists. `unavailable` — the api is down, or the
 * address has used its budget — is "try again later".
 */
export type CsatLinkProblem = 'not-found' | 'unavailable';

export class CsatLinkError extends Error {
  readonly problem: CsatLinkProblem;

  constructor(problem: CsatLinkProblem) {
    super(`csat: ${problem}`);
    this.name = 'CsatLinkError';
    this.problem = problem;
  }
}

export const isCsatLinkError = (error: unknown): error is CsatLinkError =>
  error instanceof CsatLinkError;
