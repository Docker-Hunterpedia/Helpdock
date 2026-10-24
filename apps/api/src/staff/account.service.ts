import type { DbTransaction } from '@helpdock/db';
import {
  normalisePhone,
  type Profile,
  type ProfileUpdateRequest,
  publicNameOf,
  type RecoveryCodes,
  type StaffSessionList,
  type TotpRotationConfirmRequest,
  type TotpRotationProof,
  type TotpRotationStart,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { AuthService } from '../auth/auth.service.js';
import { AuthFailure } from '../auth/auth-failure.js';
import type { PasskeyService } from '../auth/passkeys/passkey.service.js';
import { PROFILE_PHOTO_RULE, type RateLimiter } from '../auth/rate-limit.js';
import type { SessionService } from '../auth/session/session.service.js';
import { runAfterCommit } from '../context/after-commit.js';
import type { Logger } from '../logging/logger.js';
import {
  assertProfilePhotoUpload,
  type EncodedPhoto,
  encodeProfilePhoto,
  PhotoRefusal,
} from './profile-photo.js';
import type { ProfilePhotoStore } from './profile-photo.store.js';
import type { StaffRepository } from './staff.repository.js';
import { StaffFailure } from './staff-failure.js';

/** A photo the gates refused is a `staff.reason` the screen has a sentence for. */
const refusalFailure = (error: unknown): unknown =>
  error instanceof PhotoRefusal ? new StaffFailure(`photo-${error.reason}`) : error;

/**
 * The four things a person may change about their own account: their name and
 * language, their password, their second factor, and which browsers are signed
 * in.
 *
 * **The audit rows are `AuthService`'s.** A password change belongs to a person
 * rather than to a brand, so it is recorded in install scope by the `auth`
 * system principal (`auth/auth-audit.ts`, ADR 0022) — never by this request's
 * staff principal, which `target-brand.ts` keeps out of install scope.
 */

export interface AccountServiceOptions {
  readonly staff: StaffRepository;
  readonly auth: AuthService;
  /** Verifies a passkey step-up for the authenticator rotation (#373). */
  readonly passkeys: PasskeyService;
  readonly sessions: SessionService;
  readonly photos: ProfilePhotoStore;
  readonly limiter: Pick<RateLimiter, 'consume'>;
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
      recoveryCodeProofAllowed: await this.#parts.auth.recoveryCodeProofAllowed(userId, tx),
      publicName: user.publicName,
      displayName: publicNameOf({ fullName: user.name, publicName: user.publicName }),
      jobTitleEn: user.jobTitleEn,
      jobTitleAr: user.jobTitleAr,
      phone: user.publicPhone,
      timeZone: user.timeZone,
      photo: await this.#parts.photos.urls(user.photoKey),
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
      ...(request.publicName === undefined ? {} : { publicName: request.publicName }),
      ...(request.jobTitleEn === undefined ? {} : { jobTitleEn: request.jobTitleEn }),
      ...(request.jobTitleAr === undefined ? {} : { jobTitleAr: request.jobTitleAr }),
      ...(request.phone === undefined ? {} : { publicPhone: this.#phone(request.phone) }),
      ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
    });

    return this.profile(tx, userId);
  }

  /**
   * Replaces the photo with `bytes`, re-encoded, and deletes the one it
   * replaced — after the commit, so a rollback leaves `users.photo_key`
   * pointing at a folder that is still there. The folder the rollback orphaned
   * is the photo sweep's (`staff/photo-sweep.job.ts`). A photo that fails the
   * gates (`PhotoRefusal`) changes nothing, and neither does a spent budget.
   */
  async setPhoto(
    tx: DbTransaction,
    userId: string,
    bytes: Uint8Array,
    declaredMime: string,
  ): Promise<Profile> {
    try {
      // The cheap refusals cost no budget: a person fumbling the file type is
      // not locked out. The budget buys the decode, which is what an abuser
      // would be after.
      assertProfilePhotoUpload(bytes, declaredMime);
    } catch (error: unknown) {
      throw refusalFailure(error);
    }
    if (!(await this.#parts.limiter.consume(PROFILE_PHOTO_RULE, userId))) {
      throw new StaffFailure('photo-rate-limited');
    }
    const encoded: EncodedPhoto = await encodeProfilePhoto(bytes, declaredMime).catch((error) => {
      throw refusalFailure(error);
    });
    const folder = await this.#parts.photos.save(userId, encoded);
    const previous = await this.#parts.staff.replacePhoto(tx, userId, folder);
    runAfterCommit(() => this.#parts.photos.removeQuietly(previous, this.#parts.logger));

    return this.profile(tx, userId);
  }

  async removePhoto(tx: DbTransaction, userId: string): Promise<Profile> {
    const previous = await this.#parts.staff.replacePhoto(tx, userId, null);
    runAfterCommit(() => this.#parts.photos.removeQuietly(previous, this.#parts.logger));

    return this.profile(tx, userId);
  }

  /** A public phone is kept in E.164 like a contact's (ADR 0008); null clears it. */
  #phone(raw: string | null): string | null {
    if (raw === null) {
      return null;
    }
    const result = normalisePhone(raw);
    if (!result.ok) {
      throw new StaffFailure('invalid-phone');
    }

    return result.value;
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

  /**
   * Step 1 of replacing the authenticator app (#373). The passkey proof is
   * verified by `PasskeyService`, against the step-up ceremony this browser
   * began, before anything is staged; the other proofs go to `AuthService`,
   * which owns the step-up budget. Either way the staged secret answers here
   * and nothing is replaced until the new app confirms a code.
   */
  async startTotpRotation(
    tx: DbTransaction,
    userId: string,
    authorization: string | undefined,
    proof: TotpRotationProof,
  ): Promise<TotpRotationStart> {
    if (proof.passkey !== undefined) {
      // Before the proof, so an account with nothing to replace spends no attempt.
      await this.#parts.auth.assertTotpRotatable(userId, tx);
      const session = await this.#parts.passkeys.sessionOf(userId, authorization, tx);
      await this.#parts.passkeys.confirmStepUp(session, proof.passkey);

      return this.#parts.auth.stageTotpRotation(userId, tx);
    }

    return this.#parts.auth.startTotpRotation({ userId, proof, tx });
  }

  /** Step 2: a code from the new app swaps the secret, under the account-row lock. */
  confirmTotpRotation(
    tx: DbTransaction,
    userId: string,
    request: TotpRotationConfirmRequest,
  ): Promise<void> {
    return this.#parts.auth.confirmTotpRotation({
      userId,
      rotationId: request.rotationId,
      code: request.code,
      tx,
    });
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
