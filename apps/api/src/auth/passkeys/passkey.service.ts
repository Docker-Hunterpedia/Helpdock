import {
  auditLog,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  type WebauthnCredential,
} from '@helpdock/db';
import {
  type InstallPasskeys,
  type InstallPasskeysMoved,
  MAX_PASSKEYS_PER_ACCOUNT,
  type Passkey,
  type PasskeyAdded,
  type PasskeyList,
  type PasskeyProof,
  type PasskeyRecoveryRedrawRequest,
  type PasskeyRegistrationOptions,
  type PasskeyStepUpOptions,
  type RecoveryCodes,
  type RegistrationResponse,
  type SessionClaims,
} from '@helpdock/schemas';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { currentRequestContext } from '../../context/request-context.js';
import type { Logger } from '../../logging/logger.js';
import type { SsoSignInPolicy } from '../../sso/sign-in-policy.js';
import type { AuthService } from '../auth.service.js';
import { AuthFailure } from '../auth-failure.js';
import { describeClient } from '../client-description.js';
import type { RateLimiter, RateLimitRule } from '../rate-limit.js';
import { bearerTokenOf, verifyAccessToken } from '../session/access-token.js';
import type { SigningKeys } from '../session/signing-keys.js';
import type { StaffUser } from '../staff.repository.js';
import { RpIdPinChangedError } from '../webauthn/rp-id-pin.js';
import type { WebAuthnService } from '../webauthn/webauthn.service.js';
import type { PasskeyRepository } from './passkey.repository.js';
import { PasskeysFailure } from './passkeys-failure.js';
import { toAuthenticationJson, toRegistrationJson, toStored } from './webauthn-json.js';

/**
 * Registering, renaming and removing a person's own passkeys (M18-02, ADR 0050,
 * DOMAIN-RULES §12.1).
 *
 * **Every change asks for a credential first** (ASVS 3.7.1): the current
 * password, a live authenticator code, or an assertion from a passkey the
 * account already holds. A session proves somebody signed in, not who is at
 * the keyboard now, and a passkey is the one factor that outlives a password
 * reset, so it is the one a stolen session would most like to plant. All three
 * spend the one step-up budget `AuthService` keeps (five in fifteen minutes).
 *
 * **Every change tells the holder** (ASVS 2.2.3, 2.5.5): an audit row, and for
 * an addition or a removal a `securityChange` email queued through the outbox
 * in the request's own transaction, so a change that rolls back sends nothing.
 *
 * **Nothing here takes a credential id without the caller's user id**, and a
 * passkey that is not the caller's answers exactly as one that does not exist.
 */

/**
 * Options are minted without a secret to compare, so they get a budget of
 * their own; sharing the step-up budget would let anyone holding a session
 * spend the owner's five attempts.
 */
const CEREMONY_OPTIONS_RULE: RateLimitRule = {
  bucket: 'passkey-options',
  limit: 30,
  windowSeconds: 15 * 60,
};

export interface PasskeyServiceOptions {
  readonly auth: AuthService;
  readonly webauthn: WebAuthnService;
  readonly passkeys: PasskeyRepository;
  readonly ssoPolicy: Pick<SsoSignInPolicy, 'breakGlassLosingPasskeys'>;
  readonly limiter: RateLimiter;
  /** Verifies the request's access token again, to read the browser session it belongs to. */
  readonly signingKeys: SigningKeys;
  readonly logger: Logger;
}

export interface PasskeySession {
  readonly userId: string;
  /** The browser session the request came in on; the ceremony is bound to it. */
  readonly familyId: string;
  readonly tx: DbTransaction;
}

const toPasskey = (row: WebauthnCredential): Passkey => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  synced: row.backedUp,
});

export class PasskeyService {
  readonly #parts: PasskeyServiceOptions;

  constructor(options: PasskeyServiceOptions) {
    this.#parts = options;
  }

  /**
   * The caller and the browser session they came in on. The guard has already
   * verified the token and checked it is not revoked; this reads the `fam`
   * claim the principal does not carry. A ceremony begun in one browser cannot
   * be finished by another, even for the same person.
   */
  async sessionOf(
    userId: string,
    authorization: string | undefined,
    tx: DbTransaction,
  ): Promise<PasskeySession> {
    const claims = await this.#verifiedClaimsOfCaller(userId, authorization);
    return { userId, familyId: claims.fam, tx };
  }

  /**
   * The verified claims of the caller's own token, or nothing. Reading the
   * header, checking the signature and comparing the subject happen in this
   * one function, so no claim an unverified token carried can ever reach the
   * comparison: `verifyAccessToken` returns claims only for a token this
   * install signed (ES256, pinned) that is still in date, and no bearer token
   * verifies as nothing, like a bad one. `userId` is the guard's principal,
   * never anything the request carried.
   */
  async #verifiedClaimsOfCaller(
    userId: string,
    authorization: string | undefined,
  ): Promise<SessionClaims> {
    const claims = await verifyAccessToken(
      bearerTokenOf(authorization) ?? '',
      this.#parts.signingKeys,
    );
    if (claims === null || claims.sub !== userId) {
      throw new UnauthorizedException('Authentication is required for this route');
    }
    return claims;
  }

  /** Settings › Authentication: whether passkeys work, which RP ID they were made for, how many. */
  async installStatus(): Promise<InstallPasskeys> {
    const status = await this.#parts.webauthn.status();
    const totals = await this.#parts.passkeys.totals();
    const blockers =
      status.state === 'paused'
        ? await this.#moveBlockers(await this.#parts.passkeys.holders())
        : { breakGlassAccounts: 0, secondFactorAccounts: 0 };
    const pinned = status.state === 'unavailable' ? null : status.pinned;

    return {
      state: status.state,
      rpId: status.state === 'unavailable' ? null : status.rpId,
      pinnedRpId: pinned?.rpId ?? null,
      pinnedAt: pinned?.pinnedAt?.toISOString() ?? null,
      pinLocked: this.#parts.webauthn.isPinLocked(),
      passkeyCount: totals.passkeys,
      holderCount: totals.holders,
      blockers,
    };
  }

  /**
   * "Move passkeys to <new host>": the install's address changed for good, so
   * every passkey made for the old one is removed and the RP ID is pinned to the
   * new host. The pin, the deletions, the forgotten recovery codes, the audit row
   * and the holders' notices are one transaction: a failure in any leaves the
   * install as it was, and a crash after commit leaves all of it. Holders' account
   * rows are locked first (DOMAIN-RULES §12.1 rule 3), and the pin moves only while
   * it still holds the old host, so two moves cannot both run.
   *
   * Refused (`move-blocked`) while it would lock out a configured
   * break-glass account under SSO enforcement, or leave an account that must have
   * a second factor with none: add an authenticator app first.
   */
  async moveToCurrentHost(actorId: string): Promise<InstallPasskeysMoved> {
    const { webauthn, passkeys, auth } = this.#parts;
    const status = await webauthn.status();
    if (status.state !== 'paused') {
      throw new PasskeysFailure('not-paused');
    }
    if (webauthn.isPinLocked()) {
      throw new PasskeysFailure('pin-locked');
    }
    const from = status.pinned.rpId;
    const to = status.rpId;

    try {
      return await webauthn.moveRpId({ from, to, actorId }, async (tx) => {
        for (const { userId } of await passkeys.holders(tx)) {
          await passkeys.lockAccount(userId, tx);
        }
        const holders = await passkeys.holders(tx);
        const blockers = await this.#moveBlockers(holders, tx);
        if (blockers.breakGlassAccounts > 0 || blockers.secondFactorAccounts > 0) {
          throw new PasskeysFailure('move-blocked');
        }

        await passkeys.removeAll(tx);
        for (const holder of holders.filter((person) => !person.totpEnabled)) {
          await auth.clearRecoveryCodes(holder.userId, tx);
        }
        const removed = holders.reduce((sum, holder) => sum + holder.passkeys, 0);
        await tx.insert(auditLog).values({
          brandId: INSTALL_SCOPE_BRAND_ID,
          actorType: 'staff',
          actorId,
          action: 'auth.passkey.rp_moved',
          targetType: 'setting',
          targetId: 'auth.webauthn.rpId',
          meta: { from, to, passkeys: removed, holders: holders.length },
        });
        for (const holder of holders) {
          await auth.notifyCredentialChange(holder.userId, 'passkeysMoved', tx, {
            account: to,
            totp: holder.totpEnabled ? '1' : '0',
          });
        }
        this.#parts.logger.warn({ from, to, removed }, 'Moved passkeys');
        return { rpId: to, passkeysRemoved: removed, holdersNotified: holders.length };
      });
    } catch (error) {
      if (error instanceof RpIdPinChangedError) {
        throw new PasskeysFailure('not-paused');
      }
      throw error;
    }
  }

  /** What a move would break; see {@link moveToCurrentHost}. */
  async #moveBlockers(
    holders: readonly { userId: string; totpEnabled: boolean }[],
    tx?: DbTransaction,
  ): Promise<InstallPasskeys['blockers']> {
    const { auth, ssoPolicy } = this.#parts;
    let secondFactorAccounts = 0;
    for (const holder of holders.filter((person) => !person.totpEnabled)) {
      // Memberships are per brand, so the required-ness is read on its own connection.
      if (await auth.secondFactorRequiredFor(holder.userId)) secondFactorAccounts += 1;
    }
    return {
      breakGlassAccounts: await ssoPolicy.breakGlassLosingPasskeys(tx),
      secondFactorAccounts,
    };
  }

  async list(userId: string, tx: DbTransaction): Promise<PasskeyList> {
    const user = await this.#parts.auth.activeAccount(userId, tx);
    const rows = await this.#parts.passkeys.ofUser(userId, tx);
    const { state } = await this.#parts.webauthn.status();

    return {
      passkeys: rows.map(toPasskey),
      limit: MAX_PASSKEYS_PER_ACCOUNT,
      state,
      removalBlocked: await this.#wouldLeaveNoSecondFactor(user, rows.length, tx),
      authenticatorApp: user.totpEnabled,
    };
  }

  /**
   * Options for proving possession of a passkey the account already holds,
   * before adding, renaming or removing one. Refused when it holds none: the
   * caller shows the password and code instead.
   */
  async stepUpOptions({ userId, familyId, tx }: PasskeySession): Promise<PasskeyStepUpOptions> {
    await this.#spendOptionsBudget(userId);
    await this.#parts.auth.activeAccount(userId, tx);
    const existing = await this.#parts.passkeys.ofUser(userId, tx);
    if (existing.length === 0) {
      throw new AuthFailure('invalid-credentials');
    }

    const { ceremonyId, options } = await this.#parts.webauthn.authenticationOptions({
      purpose: 'step-up',
      binding: { userId, familyId },
      allow: existing,
    });
    return { ceremonyId, options: { ...options } };
  }

  /**
   * Step 1 of adding a passkey: the step-up, then the browser's creation
   * options. The limit is checked before the step-up, so a full account is
   * told so without spending an attempt.
   */
  async beginRegistration(
    session: PasskeySession,
    proof: PasskeyProof,
  ): Promise<PasskeyRegistrationOptions> {
    const { userId, tx } = session;
    await this.#spendOptionsBudget(userId);
    const user = await this.#parts.auth.activeAccount(userId, tx);
    const existing = await this.#parts.passkeys.ofUser(userId, tx);
    if (existing.length >= MAX_PASSKEYS_PER_ACCOUNT) {
      throw new AuthFailure('passkey-limit');
    }

    await this.#confirm(session, proof);

    const handle = await this.#parts.passkeys.userHandle(userId, tx);
    const { ceremonyId, options } = await this.#parts.webauthn.registrationOptions({
      user: { handle, email: user.email, name: user.name },
      existing,
      binding: { userId, familyId: session.familyId },
    });
    return { ceremonyId, options: { ...options } };
  }

  /**
   * Step 2: checks what the authenticator made against the ceremony the same
   * session began, and stores it under the name the person chose. The ceremony
   * is spent before anything is checked, so a replay, a stale answer or an
   * answer for another purpose, person or browser all end here with
   * `challenge-expired` and nothing stored.
   */
  async finishRegistration(
    session: PasskeySession,
    input: {
      readonly ceremonyId: string;
      readonly response: RegistrationResponse;
      readonly name: string;
    },
  ): Promise<PasskeyAdded> {
    const { userId, tx } = session;
    const { passkeys, webauthn, auth, logger } = this.#parts;
    // Two registrations at once must not both pass the count below.
    await passkeys.lockAccount(userId, tx);
    const user = await auth.activeAccount(userId, tx);

    const registered = await webauthn.verifyRegistration({
      ceremonyId: input.ceremonyId,
      binding: { userId, familyId: session.familyId },
      response: toRegistrationJson(input.response),
    });

    const held = await passkeys.count(userId, tx);
    if (held >= MAX_PASSKEYS_PER_ACCOUNT) {
      throw new AuthFailure('passkey-limit');
    }
    const row = await passkeys.add(userId, input.name, registered, tx);
    if (row === 'duplicate') {
      logger.warn({ userId }, 'A passkey registration named an authenticator already stored');
      throw new AuthFailure('passkey-duplicate');
    }
    // One set of codes per account, drawn with its first second factor of either kind.
    const recoveryCodes =
      !user.totpEnabled && held === 0 ? await auth.issueRecoveryCodes(userId, tx) : undefined;

    logger.info({ userId, passkeyId: row.id }, 'Registered a passkey');
    await auth.recordCredentialEvent('auth.passkey.added', userId, 'staff', {
      passkey: row.id,
      name: row.name,
      synced: row.backedUp,
    });
    const client = currentRequestContext()?.client;
    await auth.notifyCredentialChange(userId, 'passkeyAdded', tx, {
      passkey: row.name,
      ...describeClient(client?.userAgent, client?.ip),
    });

    return { ...toPasskey(row), ...(recoveryCodes === undefined ? {} : { recoveryCodes }) };
  }

  async rename(
    session: PasskeySession,
    id: string,
    name: string,
    proof: PasskeyProof,
  ): Promise<Passkey> {
    const { userId, tx } = session;
    const current = await this.#parts.passkeys.find(userId, id, tx);
    if (current === undefined) {
      throw new NotFoundException('No such passkey');
    }

    await this.#confirm(session, proof);
    if (current.name === name) {
      return toPasskey(current);
    }

    const renamed = await this.#parts.passkeys.rename(userId, id, name, tx);
    if (renamed === undefined) {
      throw new NotFoundException('No such passkey');
    }
    await this.#parts.auth.recordCredentialEvent('auth.passkey.renamed', userId, 'staff', {
      passkey: id,
      from: current.name,
      to: renamed.name,
    });
    return toPasskey(renamed);
  }

  async remove(session: PasskeySession, id: string, proof: PasskeyProof): Promise<void> {
    const { userId, tx } = session;
    const { passkeys, auth, logger } = this.#parts;
    // Two removals at once must not both see a passkey left.
    await passkeys.lockAccount(userId, tx);
    const user = await auth.activeAccount(userId, tx);
    const held = await passkeys.ofUser(userId, tx);
    if (!held.some((row) => row.id === id)) {
      throw new NotFoundException('No such passkey');
    }
    // Before the step-up, so the refusal spends no attempt.
    if (await this.#wouldLeaveNoSecondFactor(user, held.length, tx)) {
      throw new AuthFailure('second-factor-required');
    }

    await this.#confirm(session, proof);

    const removed = await passkeys.remove(userId, id, tx);
    if (removed === undefined) {
      throw new NotFoundException('No such passkey');
    }
    if (held.length === 1 && !user.totpEnabled) {
      // No second factor is left, so the codes that stood in for one go with it.
      await auth.clearRecoveryCodes(userId, tx);
    }
    logger.warn({ userId, passkeyId: id }, 'Removed a passkey');
    await auth.recordCredentialEvent('auth.passkey.removed', userId, 'staff', {
      passkey: id,
      name: removed.name,
    });
    await auth.notifyCredentialChange(userId, 'passkeyRemoved', tx, {
      passkey: removed.name,
      remaining: String(held.length - 1),
      totp: user.totpEnabled ? '1' : '0',
    });
  }

  /**
   * Draws ten new recovery codes after an assertion from a passkey the account
   * holds (M18-03); the TOTP route, `POST /api/me/recovery-codes/regenerate`,
   * stays the way to do it with a code. The step-up budget is spent as for any
   * other change, and the account is locked so the answer cannot race the
   * removal of the passkey that proved it.
   */
  async regenerateRecoveryCodes(
    session: PasskeySession,
    request: PasskeyRecoveryRedrawRequest,
  ): Promise<RecoveryCodes> {
    const { userId, tx } = session;
    await this.#parts.passkeys.lockAccount(userId, tx);
    await this.#confirmWithPasskey(session, request.passkey);
    return this.#parts.auth.regenerateRecoveryCodesAfterPasskey(userId, tx);
  }

  /**
   * Whether removing a passkey would leave an account that must have a second
   * factor without one. Only the last passkey can: TOTP, or another passkey,
   * still counts (DOMAIN-RULES §12.1 rule 2).
   */
  async #wouldLeaveNoSecondFactor(
    user: StaffUser,
    held: number,
    tx: DbTransaction,
  ): Promise<boolean> {
    return (
      held === 1 && !user.totpEnabled && (await this.#parts.auth.isSecondFactorRequired(user, tx))
    );
  }

  async #confirm({ userId, familyId, tx }: PasskeySession, proof: PasskeyProof): Promise<void> {
    if (proof.passkey === undefined) {
      await this.#parts.auth.confirmWithSecret(
        userId,
        {
          ...(proof.currentPassword === undefined
            ? {}
            : { currentPassword: proof.currentPassword }),
          ...(proof.code === undefined ? {} : { code: proof.code }),
        },
        tx,
      );
      return;
    }
    await this.#confirmWithPasskey({ userId, familyId, tx }, proof.passkey);
  }

  /**
   * The passkey half of "confirm it's you", for a change that lives outside
   * this card: replacing the authenticator app (#373) asks for the same
   * assertion in answer to the same step-up ceremony. The account service
   * proves the session, then hands the proof here before asking
   * `AuthService` to stage anything.
   */
  async confirmStepUp(
    session: PasskeySession,
    proof: NonNullable<PasskeyProof['passkey']>,
  ): Promise<void> {
    await this.#confirmWithPasskey(session, proof);
  }

  /**
   * An assertion from a passkey the account already holds, in answer to the
   * step-up ceremony this session began. Every refusal is `invalid-credentials`
   * to the caller and keeps its reason for the audit trail.
   */
  async #confirmWithPasskey(
    { userId, familyId, tx }: PasskeySession,
    proof: NonNullable<PasskeyProof['passkey']>,
  ): Promise<void> {
    const { auth, webauthn, passkeys } = this.#parts;
    await auth.spendStepUpAttempt(userId);

    let presented: string | undefined;
    const check = await webauthn.verifyAuthentication({
      purpose: 'step-up',
      binding: { userId, familyId },
      ceremonyId: proof.ceremonyId,
      response: toAuthenticationJson(proof.response),
      findCredential: async (credentialId) => {
        const row = await passkeys.byCredentialId(credentialId, tx);
        presented = row?.id;
        return row === undefined ? undefined : toStored(row);
      },
    });

    if (!check.ok) {
      await auth.recordCredentialEvent('auth.step_up.refused', userId, 'system', {
        reason: `passkey-${check.reason}`,
      });
      if (check.reason === 'counter-regressed') {
        await auth.recordCredentialEvent('auth.passkey.counter_regressed', userId, 'system', {
          passkey: presented,
        });
      }
      throw new AuthFailure('invalid-credentials');
    }

    await passkeys.markUsed(check.credential.credentialId, check.newSignCount, check.backedUp, tx);
  }

  async #spendOptionsBudget(userId: string): Promise<void> {
    if (!(await this.#parts.limiter.consume(CEREMONY_OPTIONS_RULE, userId))) {
      throw new AuthFailure('rate-limited');
    }
  }
}
