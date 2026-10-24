import { createHash } from 'node:crypto';
import {
  auditLog,
  brands,
  type DbTransaction,
  INSTALL_SCOPE_BRAND_ID,
  type User,
} from '@helpdock/db';
import type {
  SecondFactorReset,
  SecondFactorResetRequest,
  SecondFactorSummary,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthService } from '../auth/auth.service.js';
import type { PasskeyService } from '../auth/passkeys/passkey.service.js';
import { type RateLimiter, SECOND_FACTOR_RESET_RULE } from '../auth/rate-limit.js';
import type { Logger } from '../logging/logger.js';
import type { SsoSignInPolicy } from '../sso/sign-in-policy.js';
import { widenInstallScope } from '../tenant/install-scope.js';
import type { StaffRepository } from './staff.repository.js';
import { StaffFailure } from './staff-failure.js';

/**
 * An install admin resetting another person's second factor (#398,
 * DOMAIN-RULES §12.1 rule 8). The person has lost both their phone and their
 * recovery codes; nobody else could help them before.
 *
 * It is an explicit, audited install-admin path (`@Requires('install:admin')`
 * puts the request in install scope and the tenant interceptor records the
 * entry). Everything that changes happens in the request's one transaction,
 * under the target's account-row lock, which every other factor change takes:
 * the app, the passkeys, the recovery codes, the audit row and the notice in the
 * outbox commit together or not at all.
 *
 * The order of the refusals is the order of what they cost. The cheap ones that
 * need no proof (self, the rate limit, nothing to reset, the factors changed,
 * the last break-glass admin) come before the admin's step-up, so they spend no
 * attempt from the shared step-up budget.
 */

export interface SecondFactorResetServiceOptions {
  readonly staff: StaffRepository;
  readonly auth: AuthService;
  readonly passkeys: PasskeyService;
  readonly ssoPolicy: Pick<SsoSignInPolicy, 'isLastBreakGlass'>;
  readonly limiter: Pick<RateLimiter, 'consume'>;
  readonly logger: Logger;
}

interface Factors {
  readonly user: User;
  readonly passkeyIds: readonly string[];
}

const digestOf = ({ user, passkeyIds }: Factors): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        user.totpEnabled ? (user.totpSecretEncrypted ?? '') : null,
        passkeyIds,
        user.recoveryCodesHashed,
      ]),
    )
    .digest('hex');

const summaryOf = (factors: Factors): SecondFactorSummary => ({
  totp: factors.user.totpEnabled,
  passkeys: factors.passkeyIds.length,
  recoveryCodes: factors.user.recoveryCodesHashed.length,
  digest: digestOf(factors),
});

export class SecondFactorResetService {
  readonly #parts: SecondFactorResetServiceOptions;

  constructor(options: SecondFactorResetServiceOptions) {
    this.#parts = options;
  }

  /** What the confirm dialog lists: the counts and the digest the reset must carry back. */
  async summary(
    tx: DbTransaction,
    actorId: string,
    targetId: string,
  ): Promise<SecondFactorSummary> {
    if (actorId === targetId) throw new StaffFailure('self');
    const factors = await this.#factorsOf(tx, targetId);
    if (!this.#resettable(factors)) throw new StaffFailure('not-resettable');

    return summaryOf(factors);
  }

  async reset({
    tx,
    actorId,
    targetId,
    authorization,
    request,
  }: {
    readonly tx: DbTransaction;
    readonly actorId: string;
    readonly targetId: string;
    readonly authorization: string | undefined;
    readonly request: SecondFactorResetRequest;
  }): Promise<SecondFactorReset> {
    const { staff, auth, passkeys, ssoPolicy, limiter, logger } = this.#parts;
    if (actorId === targetId) throw new StaffFailure('self');
    if (!(await limiter.consume(SECOND_FACTOR_RESET_RULE, actorId))) {
      throw new StaffFailure('reset-rate-limited');
    }

    // The guard has admitted an install admin; this is the second look the
    // route promises, on the row itself, so a demotion that landed meanwhile counts.
    const actor = await staff.findUser(tx, actorId);
    if (actor === undefined || !actor.installAdmin || actor.status !== 'active') {
      throw new StaffFailure('out-of-scope');
    }

    // The notice goes through the outbox of the person's brand, which install
    // scope cannot see until it is widened to the active brands.
    await widenInstallScope(tx, await this.#activeBrandIds(tx));
    await passkeys.lockAccount(targetId, tx);
    const factors = await this.#factorsOf(tx, targetId);
    if (!this.#resettable(factors)) throw new StaffFailure('not-resettable');
    if (digestOf(factors) !== request.digest) throw new StaffFailure('second-factor-changed');
    if (await ssoPolicy.isLastBreakGlass(targetId, tx)) throw new StaffFailure('last-break-glass');

    // Spends the shared step-up budget; a wrong proof throws and the request's transaction rolls back.
    if (request.proof.passkey === undefined) {
      await auth.confirmWithSecret(
        actorId,
        {
          ...(request.proof.currentPassword === undefined
            ? {}
            : { currentPassword: request.proof.currentPassword }),
          ...(request.proof.code === undefined ? {} : { code: request.proof.code }),
        },
        tx,
      );
    } else {
      await passkeys.confirmStepUp(
        await passkeys.sessionOf(actorId, authorization, tx),
        request.proof.passkey,
      );
    }

    const removed: SecondFactorReset = {
      totp: factors.user.totpEnabled,
      passkeys: await passkeys.removeAllOf(targetId, tx),
      recoveryCodes: factors.user.recoveryCodesHashed.length,
    };
    await auth.resetSecondFactorOf(targetId, tx);
    await tx.insert(auditLog).values({
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorType: 'staff',
      actorId,
      action: 'auth.second_factor.reset',
      targetType: 'user',
      targetId,
      meta: { ...removed },
    });
    await auth.notifyCredentialChange(targetId, 'secondFactorReset', tx, { actor: actor.name });
    logger.warn({ actorId, targetId, ...removed }, 'An install admin reset a second factor');

    return removed;
  }

  async #activeBrandIds(tx: DbTransaction): Promise<string[]> {
    const rows = await tx.select({ id: brands.id }).from(brands).where(eq(brands.status, 'active'));

    return rows.map((row) => row.id);
  }

  #resettable({ user, passkeyIds }: Factors): boolean {
    return user.status === 'active' && (user.totpEnabled || passkeyIds.length > 0);
  }

  async #factorsOf(tx: DbTransaction, targetId: string): Promise<Factors> {
    const user = await this.#parts.staff.findUser(tx, targetId);
    if (user === undefined) throw new NotFoundException('No such account');

    return { user, passkeyIds: await this.#parts.passkeys.idsOf(targetId, tx) };
  }
}
