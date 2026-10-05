import { auditLog, type Db, INSTALL_SCOPE_BRAND_ID, withTenant } from '@helpdock/db';
import { currentRequestContext } from '../context/request-context.js';
import type { Logger } from '../logging/logger.js';
import { AUTH_SYSTEM_PRINCIPAL } from './staff.repository.js';

/**
 * The authentication trail of ASVS 7.1.3 and 7.2.1: every sign-in that
 * succeeded or failed, every lock and refused step-up, and every change to a
 * credential, in `audit_log` where an install admin reads them (ADR 0020).
 *
 * **Install scope.** A sign-in belongs to a person, and a person is not a
 * brand's: the same account works in several, and a failed attempt may name
 * nobody at all. So the rows carry `INSTALL_SCOPE_BRAND_ID` and are written by
 * the `auth` system principal — the same named system path `staff.repository.ts`
 * reads memberships through — never by the staff principal of the request,
 * which `target-brand.ts` keeps out of install scope.
 *
 * **A transaction of its own.** A failure is reported by throwing, which rolls
 * the request back; a trail written inside it would lose exactly the rows it
 * exists for. The cost is that a credential change whose request fails after
 * this point leaves a row for a change that did not commit, which is why the
 * services record a change only once it is written.
 *
 * **Never the secret, never the address typed.** `meta` says which method and
 * why; an unknown address is recorded as unknown, not spelled out, because the
 * trail is read by more people than the sign-in form is.
 *
 * Writing it must not decide whether someone can sign in, so a failure to write
 * is logged and swallowed.
 */

export type AuthAuditAction =
  | 'auth.sign_in.succeeded'
  | 'auth.sign_in.failed'
  | 'auth.second_factor.failed'
  | 'auth.second_factor.replayed'
  | 'auth.account.locked'
  | 'auth.step_up.refused'
  | 'auth.refresh_token.reused'
  | 'auth.password.changed'
  | 'auth.password.reset'
  | 'auth.second_factor.enabled'
  | 'auth.second_factor.disabled'
  | 'auth.recovery_codes.regenerated'
  | 'auth.recovery_code.used';

export type SignInMethod = 'password' | 'magic-link' | 'oauth' | 'invite' | 'second-factor';

export interface AuthAuditEntry {
  readonly action: AuthAuditAction;
  /** The account the event is about; null when the address named nobody. */
  readonly userId: string | null;
  /**
   * `staff` when the account holder did it (a success, a change from inside a
   * session); `system` when the api is reporting something done *to* the
   * account by whoever was at the form.
   */
  readonly actor: 'staff' | 'system';
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface AuthAuditTrail {
  record(entry: AuthAuditEntry): Promise<void>;
}

export class DbAuthAuditTrail implements AuthAuditTrail {
  readonly #db: Db;
  readonly #logger: Logger;

  constructor({ db, logger }: { readonly db: Db; readonly logger: Logger }) {
    this.#db = db;
    this.#logger = logger;
  }

  async record({ action, userId, actor, meta = {} }: AuthAuditEntry): Promise<void> {
    const request = currentRequestContext();

    try {
      await withTenant(
        this.#db,
        {
          brandIds: [INSTALL_SCOPE_BRAND_ID],
          departmentIds: 'all',
          principalType: 'system',
          principalId: AUTH_SYSTEM_PRINCIPAL,
          ...(request === undefined
            ? {}
            : {
                request: {
                  requestId: request.requestId,
                  ip: request.client?.ip ?? null,
                  userAgent: request.client?.userAgent ?? null,
                },
              }),
        },
        (tx) =>
          tx.insert(auditLog).values({
            brandId: INSTALL_SCOPE_BRAND_ID,
            actorType: actor,
            actorId: actor === 'staff' && userId !== null ? userId : AUTH_SYSTEM_PRINCIPAL,
            action,
            targetType: 'user',
            targetId: userId,
            meta: { ...meta },
          }),
      );
    } catch (error) {
      this.#logger.error({ err: error, action, userId }, 'Could not write an auth audit row');
    }
  }
}
