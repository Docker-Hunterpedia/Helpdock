import {
  auditLog,
  type Db,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  systemContext,
  withTenant,
} from '@helpdock/db';
import type { UnsubscribeView } from '@helpdock/schemas';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import type { NotificationsRepository } from './notifications.repository.js';
import type { UnsubscribeSubject, UnsubscribeTokens } from './unsubscribe-tokens.js';

/**
 * The public half of M14-11: what a notification email's unsubscribe link
 * opens, and what a mail client's one-click POST does (RFC 8058).
 *
 * **Nothing here takes a session.** The signed token is the credential, and it
 * is checked, with its purpose, signature and age, before the database is
 * touched. It names one user and authorises one thing for that user: turning
 * notification email off. There is no input from which another person's id,
 * another setting or another action could be reached.
 *
 * **No oracle.** A token that is malformed, forged, expired, for a deactivated
 * or deleted account is the same 404 (a rate-limited request is a 429, which
 * says nothing about the token). The page can
 * therefore never be used to ask whether an address has an account here, and
 * the confirmation shows the address only to the holder of a token we signed
 * for it.
 *
 * **GET reads, POST writes.** Mail scanners and link previews follow every URL
 * in a message; only the explicit POST of the confirmation page, or of a mail
 * client's one-click button, changes anything.
 *
 * **An audited system path.** `users` and `notification_prefs` are global, so
 * the transaction is the system principal `unsubscribe:<userId>` at install
 * scope, and the first unsubscribe writes `notification.email_unsubscribed`
 * there. A repeat finds the state already set and writes nothing more: the
 * action is idempotent, so a replayed token (a forwarded email, a client that
 * retries) changes nothing.
 */

/**
 * Per IP, both routes together. Generous, because the large mailbox providers
 * send one-click POSTs from shared addresses; a token is 256 bits of MAC, so
 * this bounds what replay and probing cost, not guessing.
 */
export const UNSUBSCRIBE_PUBLIC_RULE: RateLimitRule = {
  bucket: 'unsubscribe-public',
  limit: 120,
  windowSeconds: 15 * 60,
};

/**
 * True when a link was issued at or before the moment the person last turned
 * email back on. Tokens carry whole seconds, so the resubscribe time is floored
 * to the second too and the same second is refused: the token cannot say which
 * side of the resubscribe it fell on, and failing closed costs one 404 on a
 * link minted in that second (the next email carries a working one), while
 * failing open is the bug this guards against, worsened by clock skew between
 * the API and the worker.
 */
export const issuedBeforeResubscribe = (issuedAt: Date, resubscribedAt: Date | null): boolean =>
  resubscribedAt !== null &&
  Math.floor(issuedAt.getTime() / 1000) <= Math.floor(resubscribedAt.getTime() / 1000);

export interface UnsubscribeServiceOptions {
  readonly db: Db;
  readonly repository: Pick<
    NotificationsRepository,
    'activeAccount' | 'emailResubscribedAt' | 'unsubscribeEmail'
  >;
  readonly tokens: UnsubscribeTokens;
  readonly limiter: RateLimiter;
  readonly now?: () => Date;
}

export class UnsubscribeService {
  readonly #options: UnsubscribeServiceOptions;
  readonly #now: () => Date;

  constructor(options: UnsubscribeServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** The confirmation page's read. Changes nothing. */
  async view(token: string, ip: string): Promise<UnsubscribeView> {
    const { userId, issuedAt } = await this.#admit(token, ip);

    return this.#asSystem(userId, async (tx) => {
      const account = await this.#activeAccountFor(tx, userId, issuedAt);

      return { state: 'confirm', email: account.email, locale: account.locale };
    });
  }

  /** The unsubscribe itself: a mail client's one-click POST, or the page's button. */
  async unsubscribe(token: string, ip: string): Promise<UnsubscribeView> {
    const { userId, issuedAt } = await this.#admit(token, ip);

    return this.#asSystem(userId, async (tx) => {
      const { repository } = this.#options;
      const account = await this.#activeAccountFor(tx, userId, issuedAt);

      if (await repository.unsubscribeEmail(tx, userId, this.#now())) {
        await tx.insert(auditLog).values({
          brandId: INSTALL_SCOPE_BRAND_ID,
          actorType: 'system',
          actorId: `unsubscribe:${userId}`,
          action: 'notification.email_unsubscribed',
          targetType: 'user',
          targetId: userId,
          meta: { tokenIssuedAt: issuedAt.toISOString() },
        });
      }

      return { state: 'done', locale: account.locale };
    });
  }

  /** The account, or the same 404 an unknown token gets: gone, deactivated, or issued before a resubscribe. */
  async #activeAccountFor(tx: DbTransaction, userId: string, issuedAt: Date) {
    const { repository } = this.#options;
    const account = await repository.activeAccount(tx, userId);
    if (
      account === undefined ||
      issuedBeforeResubscribe(issuedAt, await repository.emailResubscribedAt(tx, userId))
    ) {
      throw new NotFoundException('No such unsubscribe link');
    }

    return account;
  }

  async #admit(token: string, ip: string): Promise<UnsubscribeSubject> {
    if (!(await this.#options.limiter.consume(UNSUBSCRIBE_PUBLIC_RULE, ip))) {
      throw new HttpException(
        'Too many requests for unsubscribe links',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const subject = this.#options.tokens.verify(token, this.#now());
    if (subject === null) {
      throw new NotFoundException('No such unsubscribe link');
    }

    return subject;
  }

  #asSystem<T>(userId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(
      this.#options.db,
      systemContext(INSTALL_SCOPE_BRAND_ID, `unsubscribe:${userId}`),
      fn,
    );
  }
}
