import type { DbTransaction, EmailDelivery } from '@helpdock/db';
import { CSAT_RATING_MAX, CSAT_RATING_MIN } from '@helpdock/schemas';
import type { SurveyEmailSource } from '../email/email-send.job.js';
import type { CsatSurveyEmail } from '../email/render-delivery.js';
import type { CsatRepository } from './csat.repository.js';
import { firstNameOf } from './csat.service.js';
import { type CsatTokens, csatSurveyUrl } from './tokens.js';

const SCORES = Array.from(
  { length: CSAT_RATING_MAX - CSAT_RATING_MIN + 1 },
  (_, index) => CSAT_RATING_MIN + index,
);

/**
 * M8-06: the survey half of a survey email, read when the email is sent.
 *
 * Each of the five links is the survey's single-use link with `rating=` — the
 * page opens with that score pressed and records nothing until Send — and
 * `lang=` in the email's language, so the page answers in the words the email
 * asked in. The closer is named on the same terms as on the page (§4.6).
 */
export class CsatEmailSource implements SurveyEmailSource {
  readonly #repository: Pick<CsatRepository, 'find' | 'closerName' | 'markSent'>;
  readonly #tokens: CsatTokens;
  readonly #appUrl: string;

  constructor(
    repository: Pick<CsatRepository, 'find' | 'closerName' | 'markSent'>,
    tokens: CsatTokens,
    appUrl: string,
  ) {
    this.#repository = repository;
    this.#tokens = tokens;
    this.#appUrl = appUrl;
  }

  async forDelivery(
    tx: DbTransaction,
    delivery: EmailDelivery,
  ): Promise<CsatSurveyEmail | undefined> {
    const survey =
      delivery.csatResponseId === null
        ? undefined
        : await this.#repository.find(tx, delivery.csatResponseId);
    if (survey === undefined) {
      return undefined;
    }

    const links = SCORES.map((rating) =>
      csatSurveyUrl(
        this.#tokens,
        this.#appUrl,
        { brandId: delivery.brandId, survey },
        { rating: String(rating), lang: delivery.locale },
      ),
    );
    if (links.some((link) => link === null)) {
      // The key that signed the survey has been rotated out: no link would open.
      return undefined;
    }
    const closer = await this.#repository.closerName(tx, survey);

    return {
      links: links.filter((link): link is string => link !== null),
      closedBy: closer === undefined ? null : firstNameOf(closer),
    };
  }

  markSent(tx: DbTransaction, surveyId: string, at: Date): Promise<void> {
    return this.#repository.markSent(tx, surveyId, at);
  }
}
