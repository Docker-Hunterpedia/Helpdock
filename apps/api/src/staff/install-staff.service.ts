import { type DbTransaction, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AuthService } from '../auth/auth.service.js';
import type { Logger } from '../logging/logger.js';
import { writeStaffAudit } from './audit.js';
import type { StaffRepository } from './staff.repository.js';
import { StaffFailure } from './staff-failure.js';

/**
 * The one staff action that is not brand-scoped: deleting an account for good
 * (DOMAIN-RULES §12, "Only after deactivation; personal data replaced, content
 * kept as 'Former staff'").
 *
 * It is an install-admin path because it is not a fact about one brand. The
 * account may work in several, and the person asking is asking about the
 * person, not about a role. `@Requires('install:admin')` puts the request in
 * install scope, which the tenant interceptor already audits on entry, and
 * `users` is a global table so the anonymising write is reachable there.
 *
 * **The memberships are left alone.** They live in `user_brand_roles`, a tenant
 * table, which an install-scope transaction cannot see — and widening the scope
 * to reach them would be the one thing install scope exists to make
 * deliberate. The account is already deactivated, so it can sign in nowhere;
 * what each brand sees afterwards is a deactivated "Former staff" row its own
 * administrator can remove, in that brand, with the brand-scoped route.
 */

export interface InstallStaffServiceOptions {
  readonly staff: StaffRepository;
  readonly auth: AuthService;
  readonly logger: Logger;
}

export class InstallStaffService {
  readonly #parts: InstallStaffServiceOptions;

  constructor(options: InstallStaffServiceOptions) {
    this.#parts = options;
  }

  async delete(tx: DbTransaction, actorId: string, userId: string): Promise<void> {
    const user = await this.#parts.staff.findUser(tx, userId);
    if (user === undefined) {
      throw new NotFoundException('No such account');
    }

    if (actorId === userId) {
      throw new StaffFailure('self');
    }

    if (user.status !== 'deactivated') {
      throw new ConflictException('Deactivate the account before deleting it');
    }

    if (!(await this.#parts.staff.anonymise(tx, userId))) {
      /* c8 ignore next 2 -- the status was just read inside this transaction. */
      throw new ConflictException('Deactivate the account before deleting it');
    }

    // Belt and braces: the account was already deactivated, so nothing should
    // be live, but a session that somehow survived must not outlive the
    // identity it belonged to.
    await this.#parts.auth.revokeAllAccess(userId, 'deleted');

    await writeStaffAudit(tx, {
      brandId: INSTALL_SCOPE_BRAND_ID,
      actorId,
      action: 'staff.deleted',
      targetId: userId,
    });

    this.#parts.logger.warn({ userId, actorId }, 'A staff account was deleted and anonymised');
  }
}
