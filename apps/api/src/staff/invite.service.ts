import { brands, type Db, type DbTransaction, withTenant } from '@helpdock/db';
import type {
  EmailTokenPayload,
  InviteAcceptRequest,
  InviteTokenPayload,
  PublicInvite,
} from '@helpdock/schemas';
import { GoneException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthService, SignInOutcome } from '../auth/auth.service.js';
import type { EmailTokenStore } from '../auth/email-token.store.js';
import { INVITE_LOOKUP_RULE, type RateLimiter } from '../auth/rate-limit.js';
import { toClientRole } from '../auth/session-view.js';
import type { Logger } from '../logging/logger.js';
import { writeStaffAudit } from './audit.js';
import { INVITE_TTL_MS, type InviteStore } from './invite.store.js';
import { departmentScopeOf } from './roles.js';
import type { StaffRepository } from './staff.repository.js';

/**
 * The two routes a stranger reaches: reading an invitation, and accepting one.
 *
 * **Why this opens its own transaction.** Both routes are `@Public()`, so there
 * is no principal and the tenant interceptor opens nothing — the same reason
 * sign-in has a system path of its own. The *token* is the credential, and it
 * names exactly one brand, so the transaction names exactly that brand and runs
 * as `principal_type = system` with `principal_id = invite`. That is narrower
 * than the sign-in path, which has to name every active brand.
 *
 * **Why reading does not spend the token.** A person opens the link, reads who
 * invited them to what, and fills a form in. A preview that burned the token
 * would mean one refresh cost them their invitation. Accepting spends it, in
 * one `GETDEL`, so two tabs racing produce exactly one account.
 *
 * **Why an expired link and a revoked one read the same.** Both answer 410 with
 * nothing but "no longer valid". A token that could tell the difference would
 * tell somebody holding an old link whether that address still works here.
 */

/** Recorded in `app.principal_id`, so the audit trail names the path. */
export const INVITE_SYSTEM_PRINCIPAL = 'invite';

/** Stands in for an inviter whose audit row is gone. */
const APP_NAME = 'Helpdock';

export interface InviteServiceOptions {
  readonly db: Db;
  readonly staff: StaffRepository;
  readonly invites: InviteStore;
  readonly tokens: EmailTokenStore;
  readonly auth: AuthService;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
}

export class InviteService {
  readonly #parts: InviteServiceOptions;

  constructor(options: InviteServiceOptions) {
    this.#parts = options;
  }

  /** What the public invite screen shows. Never spends the token. */
  async preview(token: string, ip: string): Promise<PublicInvite> {
    await this.#assertAllowed(ip);

    const payload = this.#asInvite(await this.#parts.tokens.read(token, 'invite'));

    return this.#inBrand(payload.brandId, async (tx) => {
      const { brandName, inviterName, departments } = await this.#describe(tx, payload);

      return {
        email: payload.email,
        inviterName,
        brandName,
        role: toClientRole(payload.role),
        departments,
        expiresAt: new Date(payload.issuedAt + INVITE_TTL_MS).toISOString(),
      };
    });
  }

  /**
   * Spends the invitation and turns it into an account with a password, then
   * signs the person in the way every other first factor ends: with the second
   * factor still to come when the install requires one.
   */
  async accept(
    token: string,
    request: InviteAcceptRequest,
    { ip, userAgent }: { readonly ip: string; readonly userAgent: string | undefined },
  ): Promise<SignInOutcome> {
    await this.#assertAllowed(ip);

    // Hashed before the token is spent, so an argon2 failure costs nothing and
    // the person can try again with the link they still hold.
    const passwordHash = await this.#parts.auth.hashPassword(request.password);
    const payload = this.#asInvite(await this.#parts.tokens.consume(token, 'invite'));

    await this.#inBrand(payload.brandId, async (tx) => {
      const user = await this.#parts.staff.findUser(tx, payload.userId);
      // A membership that is gone means the invitation was revoked between the
      // email and the click; an account that is no longer `invited` means it
      // has already been accepted.
      if (
        user === undefined ||
        user.status !== 'invited' ||
        (await this.#parts.staff.find(tx, payload.userId)) === undefined
      ) {
        throw new GoneException('That invitation is no longer valid');
      }

      await this.#parts.staff.activate(tx, payload.userId, {
        name: request.name,
        locale: request.locale,
        passwordHash,
      });

      await writeStaffAudit(tx, {
        brandId: payload.brandId,
        actorId: payload.userId,
        action: 'staff.invite.accepted',
        targetId: payload.userId,
        meta: { role: payload.role, departmentIds: payload.departmentIds },
      });
    });

    await this.#parts.invites.take(payload.brandId, payload.userId);
    this.#parts.logger.info(
      { userId: payload.userId, brandId: payload.brandId },
      'A staff invitation was accepted',
    );

    return this.#parts.auth.signInAfterInvite(payload.userId, userAgent);
  }

  // ------------------------------------------------------------------

  async #assertAllowed(ip: string): Promise<void> {
    if (!(await this.#parts.limiter.consume(INVITE_LOOKUP_RULE, ip))) {
      this.#parts.logger.warn({ ip }, 'An invite request was refused by the rate limit');
      throw new GoneException('That invitation is no longer valid');
    }
  }

  /** Every failure reads the same, so a token cannot answer a question about an address. */
  #asInvite(payload: EmailTokenPayload | null): InviteTokenPayload {
    if (payload === null || payload.purpose !== 'invite') {
      throw new GoneException('That invitation is no longer valid');
    }

    return payload;
  }

  #inBrand<T>(brandId: string, fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
    return withTenant(
      this.#parts.db,
      {
        brandIds: [brandId],
        departmentIds: 'all',
        principalType: 'system',
        principalId: INVITE_SYSTEM_PRINCIPAL,
      },
      fn,
    );
  }

  async #describe(
    tx: DbTransaction,
    payload: InviteTokenPayload,
  ): Promise<{ brandName: string; inviterName: string; departments: string[] }> {
    const user = await this.#parts.staff.findUser(tx, payload.userId);
    const member = await this.#parts.staff.find(tx, payload.userId);
    if (user === undefined || user.status !== 'invited' || member === undefined) {
      throw new GoneException('That invitation is no longer valid');
    }

    const rows = await tx
      .select({ name: brands.name })
      .from(brands)
      .where(eq(brands.id, payload.brandId))
      .limit(1);

    const scope = departmentScopeOf(member.membership.departmentIds);
    const named =
      scope === 'all'
        ? []
        : (await this.#parts.staff.departmentsByIds(tx, scope)).map(
            (department) => department.name,
          );

    return {
      brandName: rows[0]?.name ?? '',
      inviterName: await this.#inviterName(tx, payload),
      departments: named,
    };
  }

  /**
   * Who sent it, for the sentence on the screen. The invitation deliberately
   * does not carry the inviter — a token a stranger holds should say as little
   * as it can — so it is read from the audit row the invitation wrote.
   *
   * The product name stands in when there is no such row, which happens when
   * retention (DOMAIN-RULES §11) has purged it or when the invitation was
   * seeded rather than sent. A screen that cannot name a person must still say
   * a sentence, and answering nothing would fail the route's own output schema.
   */
  async #inviterName(tx: DbTransaction, payload: InviteTokenPayload): Promise<string> {
    const actorId = await this.#parts.staff.inviterOf(tx, payload.userId);
    const inviter = actorId === null ? undefined : await this.#parts.staff.findUser(tx, actorId);

    return inviter?.name ?? APP_NAME;
  }
}
