import type { Settings } from '@helpdock/config';
import type { Brand, DbTransaction, Department as DepartmentRow, User } from '@helpdock/db';
import { createI18n, type Locale } from '@helpdock/i18n';
import type {
  BrandRole,
  StaffInviteRequest,
  StaffList,
  StaffMember,
  StaffUpdateRequest,
} from '@helpdock/schemas';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { AuthService } from '../auth/auth.service.js';
import type { EmailTokenStore } from '../auth/email-token.store.js';
import { EMAIL_DISPATCH_RULE, type RateLimiter } from '../auth/rate-limit.js';
import type { SessionService } from '../auth/session/session.service.js';
import type { Logger } from '../logging/logger.js';
import { writeStaffAudit } from './audit.js';
import { INVITE_TTL_DAYS, INVITE_TTL_SECONDS, type InviteStore } from './invite.store.js';
import type { StaffLifecycleHooks } from './lifecycle-hooks.js';
import { departmentIdsFor, departmentScopeOf, toBrandRole } from './roles.js';
import type { StaffRepository, StaffRow } from './staff.repository.js';
import { StaffFailure } from './staff-failure.js';
import { type StaffActor, staffActionRefusal } from './staff-scope.js';
import { toStaffMember } from './staff-view.js';

/**
 * Staff and roles inside one brand: the list, the invitations, and every
 * lifecycle change in
 * [DOMAIN-RULES §12](../../../../docs/planning/DOMAIN-RULES.md#12-staff-lifecycle).
 *
 * Three things hold across all of it.
 *
 * **The transaction is the caller's.** Every method takes the request's `tx`,
 * so the reads are already narrowed to this brand by row-level security and the
 * audit row rolls back with whatever it was about.
 *
 * **Who may do it is decided in one place.** `staff-scope.ts` is the matrix;
 * nothing here re-derives it, so a route cannot accidentally be more permissive
 * than the rule.
 *
 * **A change that narrows what somebody may see revokes their sessions.** §12
 * again: the next access token has to carry the new claims, and the ten minutes
 * DOMAIN-RULES §1.6 allows is the cap on how stale the current one can be.
 */

export interface StaffServiceOptions {
  readonly staff: StaffRepository;
  readonly invites: InviteStore;
  readonly tokens: EmailTokenStore;
  readonly sessions: SessionService;
  readonly auth: AuthService;
  readonly limiter: RateLimiter;
  readonly settings: Settings;
  readonly hooks: StaffLifecycleHooks;
  readonly logger: Logger;
  readonly appUrl: string;
}

export interface StaffContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: StaffActor;
}

export class StaffService {
  readonly #parts: StaffServiceOptions;

  constructor(options: StaffServiceOptions) {
    this.#parts = options;
  }

  async list(context: StaffContext, search: string | undefined): Promise<StaffList> {
    const rows = await this.#parts.staff.list(context.tx, search);
    const departments = await this.#departmentIndex(context.tx);
    const lastActive = await this.#parts.sessions.lastActiveOf(rows.map((row) => row.user.id));
    const pending = await this.#parts.invites.readMany(
      context.brandId,
      rows.filter((row) => row.user.status === 'invited').map((row) => row.user.id),
    );

    return {
      staff: rows.map((row) =>
        toStaffMember({
          row,
          departments,
          pendingInvite: pending.get(row.user.id) ?? null,
          lastActiveAt: lastActive.get(row.user.id) ?? null,
          viewerId: context.actor.userId,
        }),
      ),
      viewerEnabled: await this.#viewerEnabled(),
    };
  }

  // ------------------------------------------------------------------
  // Invitations
  // ------------------------------------------------------------------

  async invite(
    context: StaffContext,
    brand: Brand,
    request: StaffInviteRequest,
  ): Promise<StaffMember> {
    const role = toBrandRole(request.role);
    const departmentIds = await this.#requireDepartments(context.tx, role, request.departmentIds);
    const scope = departmentScopeOf(departmentIds);

    this.#refuse(
      staffActionRefusal({
        actor: context.actor,
        assigning: { role, departmentIds: scope },
        viewerEnabled: await this.#viewerEnabled(),
      }),
    );

    const user = await this.#accountForInvite(context, request.email);
    await this.#parts.staff.createMembership(context.tx, {
      userId: user.id,
      brandId: context.brandId,
      role,
      departmentIds,
    });

    // An account that already works here needs no invitation: it has a
    // password, and a link that could set a new one would be a way to take
    // over somebody else's account with an invitation. It simply gains the
    // role, and appears in the list as active straight away.
    if (user.status === 'invited') {
      await this.#issueInvite({ context, brand, user, role, scope });
    }
    await writeStaffAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'staff.invited',
      targetId: user.id,
      meta: { email: user.email, role, departmentIds: scope },
    });

    return this.#viewOf(context, user.id);
  }

  /**
   * A fresh token, and the previous one destroyed in the same breath. Two live
   * invitations for one person would make "single-use" of DOMAIN-RULES §12 a
   * half-truth, and would mean revoking an invitation left a working link.
   */
  async resendInvite(context: StaffContext, brand: Brand, userId: string): Promise<void> {
    const row = await this.#requirePendingInvite(context, userId);

    this.#refuse(
      staffActionRefusal({
        actor: context.actor,
        target: this.#targetOf(row),
        viewerEnabled: await this.#viewerEnabled(),
      }),
    );

    await this.#issueInvite({
      context,
      brand,
      user: row.user,
      role: row.membership.role,
      scope: departmentScopeOf(row.membership.departmentIds),
    });
    await writeStaffAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'staff.invite.resent',
      targetId: userId,
      meta: { email: row.user.email },
    });
  }

  async revokeInvite(context: StaffContext, userId: string): Promise<void> {
    const row = await this.#requirePendingInvite(context, userId);

    this.#refuse(
      staffActionRefusal({
        actor: context.actor,
        target: this.#targetOf(row),
        viewerEnabled: await this.#viewerEnabled(),
      }),
    );

    await this.#parts.staff.deleteMembership(context.tx, row.membership.id);
    await this.#forgetInvite(context.brandId, userId);

    // An account that was only ever this invitation leaves with it. One that
    // works in another brand keeps everything but the role just removed.
    if (!(await this.#parts.staff.hasMembership(context.tx, userId))) {
      await this.#parts.staff.deleteInvitedUser(context.tx, userId);
    }

    await writeStaffAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'staff.invite.revoked',
      targetId: userId,
      meta: { email: row.user.email },
    });
  }

  // ------------------------------------------------------------------
  // Changing somebody
  // ------------------------------------------------------------------

  async update(
    context: StaffContext,
    userId: string,
    request: StaffUpdateRequest,
  ): Promise<StaffMember> {
    const row = await this.#requireMember(context, userId);
    const previous = {
      role: row.membership.role,
      departmentIds: departmentScopeOf(row.membership.departmentIds),
    };

    const role = request.role === undefined ? previous.role : toBrandRole(request.role);
    const chosen =
      request.departmentIds ?? (previous.departmentIds === 'all' ? [] : previous.departmentIds);
    const departmentIds = await this.#requireDepartments(context.tx, role, chosen);
    const scope = departmentScopeOf(departmentIds);

    this.#refuse(
      staffActionRefusal({
        actor: context.actor,
        target: this.#targetOf(row),
        assigning: { role, departmentIds: scope },
        viewerEnabled: await this.#viewerEnabled(),
        // Demoting the last install admin to Viewer and then turning the
        // Viewer role off would leave them with no usable membership and no
        // way to sign in — the same lock-out deactivating them would cause.
        wouldRemoveLastInstallAdmin:
          role === 'viewer' && (await this.#isLastInstallAdmin(context, row.user)),
      }),
    );

    await this.#parts.staff.updateMembership(context.tx, row.membership.id, {
      role,
      departmentIds,
    });
    await this.#revokeAndNotify(context, userId, 'role-change');
    await this.#parts.hooks.onStaffScopeChanged({
      tx: context.tx,
      brandId: context.brandId,
      userId,
      actorId: context.actor.userId,
    });

    await writeStaffAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'staff.role.changed',
      targetId: userId,
      meta: { from: previous, to: { role, departmentIds: scope } },
    });

    return this.#viewOf(context, userId);
  }

  /**
   * Deactivation is an **account** state, not a membership one: a deactivated
   * person cannot sign in by any route, in any brand (DOMAIN-RULES §12, and
   * `AuthService` refuses them). Taking somebody out of one brand alone is
   * {@link removeFromBrand}, which is the scoped half of the same table row.
   */
  async setActivation(
    context: StaffContext,
    userId: string,
    active: boolean,
  ): Promise<StaffMember> {
    const row = await this.#requireMember(context, userId);

    // The one action here whose effect is not confined to this brand, so it
    // takes the brand's highest standing. A Team Leader manages agents inside
    // their departments; they do not decide whether somebody may sign in to an
    // install.
    if (context.actor.role !== 'admin') {
      throw new StaffFailure('out-of-scope');
    }

    this.#refuse(
      staffActionRefusal({
        actor: context.actor,
        target: this.#targetOf(row),
        viewerEnabled: await this.#viewerEnabled(),
        wouldRemoveLastInstallAdmin: !active && (await this.#isLastInstallAdmin(context, row.user)),
      }),
    );

    await this.#parts.staff.setDeactivated(context.tx, userId, !active);

    const event = {
      tx: context.tx,
      brandId: context.brandId,
      userId,
      actorId: context.actor.userId,
    };
    if (active) {
      await this.#parts.hooks.onStaffReactivated(event);
    } else {
      await this.#parts.auth.revokeAllAccess(userId, 'deactivated');
      await this.#parts.hooks.onStaffDeactivated(event);
    }

    await writeStaffAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: active ? 'staff.reactivated' : 'staff.deactivated',
      targetId: userId,
    });

    return this.#viewOf(context, userId);
  }

  /** DOMAIN-RULES §12: "the same as deactivation, scoped to that brand". */
  async removeFromBrand(context: StaffContext, userId: string): Promise<void> {
    const row = await this.#requireMember(context, userId);

    this.#refuse(
      staffActionRefusal({
        actor: context.actor,
        target: this.#targetOf(row),
        viewerEnabled: await this.#viewerEnabled(),
        // A session is only ever minted for an account that holds a brand role,
        // so taking the last install admin's role away locks the operator out
        // of their own install with no way back in.
        wouldRemoveLastInstallAdmin: await this.#isLastInstallAdmin(context, row.user),
      }),
    );

    await this.#parts.staff.deleteMembership(context.tx, row.membership.id);
    await this.#forgetInvite(context.brandId, userId);
    await this.#revokeAndNotify(context, userId, 'role-removed');
    // "The same as deactivation scoped to that brand" (§12): with no
    // membership left, every open ticket of theirs here is one they cannot work.
    await this.#parts.hooks.onStaffScopeChanged({
      tx: context.tx,
      brandId: context.brandId,
      userId,
      actorId: context.actor.userId,
    });

    await writeStaffAudit(context.tx, {
      brandId: context.brandId,
      actorId: context.actor.userId,
      action: 'staff.removed',
      targetId: userId,
      meta: { role: row.membership.role },
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  async #viewerEnabled(): Promise<boolean> {
    return this.#parts.settings.get('roles.viewerEnabled');
  }

  #refuse(refusal: ReturnType<typeof staffActionRefusal>): void {
    if (refusal !== null) {
      throw new StaffFailure(refusal);
    }
  }

  #targetOf(row: StaffRow) {
    return {
      userId: row.user.id,
      role: row.membership.role,
      departmentIds: departmentScopeOf(row.membership.departmentIds),
    };
  }

  async #departmentIndex(tx: DbTransaction): Promise<Map<string, DepartmentRow>> {
    const rows = await this.#parts.staff.departments(tx);

    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * The chosen departments, proved to belong to this brand. Row-level security
   * already makes a foreign brand's department invisible, so the check is a
   * count: anything the read did not return was not this brand's to assign, and
   * the request is refused rather than quietly narrowed.
   */
  async #requireDepartments(
    tx: DbTransaction,
    role: BrandRole,
    departmentIds: readonly string[],
  ): Promise<string[] | null> {
    const unique = [...new Set(departmentIds)];
    if (unique.length > 0) {
      const found = await this.#parts.staff.departmentsByIds(tx, unique);
      if (found.length !== unique.length) {
        throw new BadRequestException('One of those departments does not belong to this brand');
      }
    }

    return departmentIdsFor(role, unique);
  }

  /**
   * The account the invitation is for: an existing one, or a new invited row.
   *
   * **Adopting an account that already exists install-wide is an Admin's
   * decision.** `users` is a global table, so an address resolves across every
   * brand; attaching a role to a stranger's account and then acting on it is
   * how a brand-scoped permission would reach out of its brand. A Team Leader
   * may invite an address nobody here uses — that creates a new account — and
   * nothing else. An install admin's account is never adoptable by anybody.
   *
   * The refusals are worded the same whichever existing state was found, so a
   * `staff:manage` holder cannot walk a list of addresses and learn who has an
   * account on this install.
   */
  async #accountForInvite(context: StaffContext, email: string): Promise<User> {
    const existing = await this.#parts.staff.findUserByEmail(context.tx, email);
    if (existing === undefined) {
      return this.#parts.staff.createInvitedUser(context.tx, {
        email,
        // A placeholder until they say who they are on the accept screen. The
        // dialog asks for an address alone, and `users.name` is not null.
        name: placeholderName(email),
      });
    }

    const member = await this.#parts.staff.find(context.tx, existing.id);
    if (member !== undefined) {
      throw new ConflictException('That address cannot be invited to this brand');
    }

    if (context.actor.role !== 'admin' || existing.installAdmin) {
      throw new StaffFailure('out-of-scope');
    }

    if (existing.status === 'deactivated') {
      throw new ConflictException('That address cannot be invited to this brand');
    }

    return existing;
  }

  async #issueInvite({
    context,
    brand,
    user,
    role,
    scope,
  }: {
    readonly context: StaffContext;
    readonly brand: Brand;
    readonly user: User;
    readonly role: BrandRole;
    readonly scope: string[] | 'all';
  }): Promise<void> {
    // The same budget the sign-in link and the password reset spend. Without
    // it, resend is an authenticated relay: an unbounded number of branded
    // messages to an address somebody else chose.
    if (!(await this.#parts.limiter.consume(EMAIL_DISPATCH_RULE, user.email))) {
      throw new HttpException(
        'Too many invitations have been sent to that address',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.#forgetInvite(context.brandId, user.id);

    const issuedAt = Date.now();
    const token = await this.#parts.tokens.issue(
      {
        purpose: 'invite',
        userId: user.id,
        email: user.email,
        brandId: context.brandId,
        role,
        departmentIds: scope,
        issuedAt,
      },
      INVITE_TTL_SECONDS,
    );

    await this.#parts.invites.remember(
      context.brandId,
      user.id,
      {
        tokenHash: this.#parts.tokens.hashOf(token),
        issuedAt,
        expiresAt: issuedAt + INVITE_TTL_SECONDS * 1000,
      },
      INVITE_TTL_SECONDS,
    );

    const locale = user.locale as Locale;
    await this.#parts.auth.sendInvite({
      to: user.email,
      url: new URL(`/invite/${encodeURIComponent(token)}`, this.#parts.appUrl).toString(),
      locale,
      expiresInDays: INVITE_TTL_DAYS,
      inviterName: await this.#inviterName(context),
      brandName: brand.name,
      roleName: roleNameIn(locale, role),
    });
  }

  /** The name on the invitation. It comes from the row, not from the claims. */
  async #inviterName(context: StaffContext): Promise<string> {
    const actor = await this.#parts.staff.findUser(context.tx, context.actor.userId);

    /* c8 ignore next -- the actor is the authenticated principal, so the row exists. */
    return actor?.name ?? 'Helpdock';
  }

  async #forgetInvite(brandId: string, userId: string): Promise<void> {
    const previous = await this.#parts.invites.take(brandId, userId);
    if (previous !== null) {
      await this.#parts.tokens.revokeByHash(previous.tokenHash);
    }
  }

  async #requireMember(context: StaffContext, userId: string): Promise<StaffRow> {
    const row = await this.#parts.staff.find(context.tx, userId);
    if (row === undefined) {
      throw new NotFoundException('Nobody with that id holds a role in this brand');
    }

    return row;
  }

  async #requirePendingInvite(context: StaffContext, userId: string): Promise<StaffRow> {
    const row = await this.#requireMember(context, userId);
    if (row.user.status !== 'invited') {
      throw new ConflictException('That invitation has already been accepted');
    }

    return row;
  }

  async #isLastInstallAdmin(context: StaffContext, user: User): Promise<boolean> {
    if (!user.installAdmin) {
      return false;
    }

    return (await this.#parts.staff.countUsableInstallAdmins(context.tx)) <= 1;
  }

  /**
   * "Refresh token family revoked so the next access token carries new claims
   * (≤ 10 min lag); sockets disconnected" (DOMAIN-RULES §12). The broadcast the
   * revocation publishes is what M0-13 listens to.
   */
  async #revokeAndNotify(context: StaffContext, userId: string, reason: string): Promise<void> {
    const revoked = await this.#parts.sessions.revokeEverything(userId, reason);

    this.#parts.logger.info(
      { brandId: context.brandId, userId, revoked, reason },
      'Revoked every session of a staff account after a role change',
    );
  }

  async #viewOf(context: StaffContext, userId: string): Promise<StaffMember> {
    const row = await this.#requireMember(context, userId);
    const departments = await this.#departmentIndex(context.tx);
    const lastActive = await this.#parts.sessions.lastActiveOf([userId]);

    return toStaffMember({
      row,
      departments,
      pendingInvite: await this.#parts.invites.read(context.brandId, userId),
      lastActiveAt: lastActive.get(userId) ?? null,
      viewerId: context.actor.userId,
    });
  }
}

/** Everything before the `@`, which is a person's name often enough to be a better start than the whole address. */
const placeholderName = (email: string): string => {
  const [local = ''] = email.trim().split('@');

  return local === '' ? email.trim() : local;
};

/**
 * The role as the recipient's catalog spells it. The invite email names the
 * role in a sentence, and a sentence with `team_leader` in it is not a
 * sentence (packages/i18n README).
 */
const roleNameIn = (locale: Locale, role: BrandRole): string => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'staff');
  const key = role === 'team_leader' ? 'teamLeader' : role;

  return t(`roles.${key}`);
};
