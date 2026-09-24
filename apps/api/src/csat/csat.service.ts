import { timingSafeEqual } from 'node:crypto';
import {
  auditLog,
  type CsatResponse,
  type Db,
  type DbTransaction,
  systemContext,
  withTenant,
} from '@helpdock/db';
import type { CsatBrand, CsatSubmitRequest, CsatSurveyView, TicketCsat } from '@helpdock/schemas';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import type { CsatRepository, SurveyWithTicket } from './csat.repository.js';
import { type CsatTokenSubject, type CsatTokens, hashCsatToken } from './tokens.js';

/**
 * The survey from both sides: the agent's summary on the ticket, and the
 * customer's rating page.
 *
 * **The public half is an explicit system path.** A person following the link
 * has no session, so there is no request transaction. The token is verified
 * first — an unsigned or altered one never reaches the database — and names
 * the brand, and the read runs in a transaction scoped to exactly that brand as
 * the system principal `csat:<surveyId>`, the way a worker job does
 * (DOMAIN-RULES §1.4). Every use of a valid link writes an `audit_log` row in
 * that brand, so the path is audited as AGENTS.md requires of a query made
 * without a caller's own tenant context.
 */

/**
 * Per IP, for both public routes together. A token is 256 bits of MAC, so this
 * does not protect against guessing; it bounds somebody replaying one link to
 * watch its state, and what each request costs.
 */
export const CSAT_PUBLIC_RULE: RateLimitRule = {
  bucket: 'csat-public',
  limit: 30,
  windowSeconds: 15 * 60,
};

const sameHash = (stored: string, presented: string): boolean => {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(presented, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
};

export interface CsatServiceOptions {
  readonly db: Db;
  readonly repository: CsatRepository;
  readonly tokens: CsatTokens;
  readonly limiter: RateLimiter;
  /** `APP_URL`: the admin app hosts the rating page (ADR 0010). */
  readonly appUrl: string;
  readonly now?: () => Date;
}

export class CsatService {
  readonly #options: CsatServiceOptions;
  readonly #now: () => Date;

  constructor(options: CsatServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ agent side

  /**
   * The survey for the ticket's latest close, as the details panel shows it,
   * read in the request's own transaction.
   */
  async forTicket(
    tx: DbTransaction,
    brandId: string,
    ticketId: string,
  ): Promise<TicketCsat | null> {
    const survey = await this.#options.repository.latestForTicket(tx, ticketId);
    if (survey === undefined) {
      return null;
    }

    const state = this.#agentState(survey);

    return {
      state,
      rating: survey.rating,
      comment: survey.comment,
      link: state === 'pending' || state === 'sent' ? this.#linkFor(brandId, survey) : null,
      expiresAt: survey.expiresAt.toISOString(),
      ratedAt: survey.ratedAt?.toISOString() ?? null,
    };
  }

  // ----------------------------------------------------------- public side

  async view(token: string, ip: string): Promise<CsatSurveyView> {
    const subject = await this.#admit(token, ip);

    return this.#inBrand(token, subject, async (tx, found, brand) => {
      await this.#audit(tx, subject, found, 'csat.viewed');

      return this.#publicView(found, brand);
    });
  }

  /**
   * Records the answer once. A second submission answers `used`, an expired
   * link `expired` — the same screens the page draws for a link opened late —
   * and neither changes the stored answer.
   */
  async submit(token: string, ip: string, request: CsatSubmitRequest): Promise<CsatSurveyView> {
    const subject = await this.#admit(token, ip);

    return this.#inBrand(token, subject, async (tx, found, brand) => {
      const rated = await this.#options.repository.rate(tx, subject.surveyId, {
        rating: request.rating,
        comment: request.comment ?? null,
        at: this.#now(),
      });

      if (!rated) {
        return this.#publicView(found, brand);
      }

      await this.#audit(tx, subject, found, 'csat.rated', { rating: request.rating });

      return { state: 'rated', brand, rating: request.rating };
    });
  }

  // ------------------------------------------------------------- internals

  async #admit(token: string, ip: string): Promise<CsatTokenSubject> {
    if (!(await this.#options.limiter.consume(CSAT_PUBLIC_RULE, ip))) {
      throw new HttpException('Too many requests for rating links', HttpStatus.TOO_MANY_REQUESTS);
    }

    const subject = this.#options.tokens.verify(token);
    if (subject === null) {
      throw new NotFoundException('No such rating link');
    }

    return subject;
  }

  /**
   * The transaction for one brand, and the survey the token names, checked
   * against the stored hash: a token signed by a key we hold, but not the one
   * the survey was issued under, is refused like a forged one.
   */
  #inBrand<T>(
    token: string,
    subject: CsatTokenSubject,
    fn: (tx: DbTransaction, found: SurveyWithTicket, brand: CsatBrand) => Promise<T>,
  ): Promise<T> {
    const context = systemContext(subject.brandId, `csat:${subject.surveyId}`);

    return withTenant(this.#options.db, context, async (tx) => {
      const found = await this.#options.repository.findWithTicket(tx, subject.surveyId);
      const brand = await this.#options.repository.brand(tx, subject.brandId);

      if (
        found === undefined ||
        brand === undefined ||
        !sameHash(found.survey.tokenHash, hashCsatToken(token))
      ) {
        throw new NotFoundException('No such rating link');
      }

      return fn(tx, found, { name: brand.name, locale: brand.defaultLocale, accent: null });
    });
  }

  #publicView({ survey, reference, subject }: SurveyWithTicket, brand: CsatBrand): CsatSurveyView {
    if (survey.ratedAt !== null) {
      return { state: 'used', brand };
    }
    if (survey.expiresAt.getTime() <= this.#now().getTime()) {
      return { state: 'expired', brand };
    }

    return { state: 'open', brand, ticket: { reference, subject } };
  }

  #agentState(survey: CsatResponse): TicketCsat['state'] {
    if (survey.ratedAt !== null) {
      return 'rated';
    }
    if (survey.expiresAt.getTime() <= this.#now().getTime()) {
      return 'expired';
    }

    return survey.sentAt === null ? 'pending' : 'sent';
  }

  /** The link whose hash is the stored one: under the current key, or the previous. */
  #linkFor(brandId: string, survey: CsatResponse): string | null {
    const token = this.#options.tokens
      .candidates({ brandId, surveyId: survey.id })
      .find((candidate) => sameHash(survey.tokenHash, hashCsatToken(candidate)));

    return token === undefined ? null : new URL(`/csat/${token}`, this.#options.appUrl).toString();
  }

  async #audit(
    tx: DbTransaction,
    subject: CsatTokenSubject,
    { survey }: SurveyWithTicket,
    action: 'csat.viewed' | 'csat.rated',
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId: subject.brandId,
      actorType: 'system',
      actorId: `csat:${subject.surveyId}`,
      action,
      targetType: 'ticket',
      targetId: survey.ticketId,
      meta,
    });
  }
}
