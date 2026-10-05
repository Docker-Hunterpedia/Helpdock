import type { DbTransaction } from '@helpdock/db';
import type {
  Profile,
  ProfileUpdateRequest,
  RecoveryCodes,
  StaffSessionList,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { AuthService } from '../auth/auth.service.js';
import { AuthFailure } from '../auth/auth-failure.js';
import type { SessionService } from '../auth/session/session.service.js';
import type { Logger } from '../logging/logger.js';
import type { StaffRepository } from './staff.repository.js';

/**
 * The four things a person may change about their own account: their name and
 * language, their password, their second factor, and which browsers are signed
 * in.
 *
 * **The audit rows are `AuthService`'s.** A password change belongs to a person
 * rather than to a brand, so it is recorded in install scope by the `auth`
 * system principal (`auth/auth-audit.ts`, ADR 0020) — never by this request's
 * staff principal, which `target-brand.ts` keeps out of install scope.
 */

export interface AccountServiceOptions {
  readonly staff: StaffRepository;
  readonly auth: AuthService;
  readonly sessions: SessionService;
  readonly logger: Logger;
}

export class AccountService {
  readonly #parts: AccountServiceOptions;

  constructor(options: AccountServiceOptions) {
    this.#parts = options;
  }

  async profile(tx: DbTransaction, userId: string): Promise<Profile> {
    const user = await this.#parts.staff.findUser(tx, userId);
    /* c8 ignore next 3 -- the guard has already resolved this principal from a live session. */
    if (user === undefined) {
      throw new NotFoundException('No such account');
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: user.locale,
      twoFactorEnabled: user.totpEnabled,
      recoveryCodesLeft: user.recoveryCodesHashed.length,
      twoFactorRequired: await this.#parts.auth.secondFactorRequiredFor(userId, tx),
    };
  }

  async updateProfile(
    tx: DbTransaction,
    userId: string,
    request: ProfileUpdateRequest,
  ): Promise<Profile> {
    await this.#parts.staff.updateProfile(tx, userId, {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.locale === undefined ? {} : { locale: request.locale }),
    });

    return this.profile(tx, userId);
  }

  /**
   * `keepFamilyId` is this browser's own refresh family, read from its cookie.
   * Every other family goes, because a password is changed when somebody thinks
   * somebody else has the old one.
   */
  async changePassword({
    tx,
    userId,
    currentPassword,
    newPassword,
    keepFamilyId,
  }: {
    readonly tx: DbTransaction;
    readonly userId: string;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly keepFamilyId: string | null;
  }): Promise<void> {
    await this.#parts.auth.changePassword({
      userId,
      currentPassword,
      newPassword,
      keepFamilyId,
      tx,
    });
  }

  disableTotp(tx: DbTransaction, userId: string, code: string): Promise<void> {
    return this.#parts.auth.disableTotp(userId, code, tx);
  }

  regenerateRecoveryCodes(tx: DbTransaction, userId: string, code: string): Promise<RecoveryCodes> {
    return this.#parts.auth.regenerateRecoveryCodes(userId, code, tx);
  }

  async sessions(userId: string, currentFamilyId: string | null): Promise<StaffSessionList> {
    const families = await this.#parts.sessions.listSessions(userId);

    return {
      sessions: families.map((family) => ({
        familyId: family.familyId,
        userAgent: family.userAgent,
        startedAt: new Date(family.issuedAt * 1000).toISOString(),
        lastUsedAt: new Date(family.lastUsedAt * 1000).toISOString(),
        current: family.familyId === currentFamilyId,
      })),
    };
  }

  /**
   * Ends one browser. A family that is not this account's answers the same
   * `no-account` a deleted one would, so the route cannot be walked to find out
   * which family ids exist.
   */
  async revokeSession(userId: string, familyId: string): Promise<void> {
    if (!(await this.#parts.sessions.revokeOwnFamily(userId, familyId, 'session-revoked'))) {
      throw new AuthFailure('no-account');
    }

    this.#parts.logger.info({ userId, familyId }, 'A staff account signed one browser out');
  }
}
