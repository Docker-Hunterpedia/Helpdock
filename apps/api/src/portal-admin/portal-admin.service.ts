import { type Db, type DbTransaction, systemContext, withTenant } from '@helpdock/db';
import {
  type AccountPortal,
  type AccountPortalUpdate,
  type ContactPortalAccess,
  type ContactPortalSignOut,
  customerSees,
  type PortalSettings,
  type PortalSettingsUpdate,
  parseBrandSettings,
  portalSeesBecause,
  type TicketPortalView,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Principal } from '../auth/principal.js';
import { enqueueSiteChanged } from '../help-center/events.js';
import { activityActorFor, writeTicketActivity } from '../tickets/ticket-activity.js';
import { enqueueTicketEvent, TICKET_EVENTS } from '../tickets/ticket-events.js';
import type { PortalAdminRepository } from './portal-admin.repository.js';
import { readTicketPortalView } from './ticket-portal-view.js';

/**
 * The staff side of the customer portal (M21-06, DOMAIN-RULES §1.2 and §4.9):
 * the brand's setting, an account's visibility and managers, a contact's portal
 * access and the private mark on a ticket.
 *
 * Every write is audited with the values that changed, and none touches a
 * secret: a session is read as a family name, a time and a host, never its
 * token hash.
 */

export interface PortalAdminContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly principal: Principal;
  /** The staff member acting; the audit row's actor. */
  readonly actorId: string;
}

/** The job id the explicit system path of "Sign out everywhere" is audited under. */
const SIGN_OUT_JOB_ID = 'portal:staff-sign-out';

const sameDepartments = (a: PortalSettings['departmentIds'], b: PortalSettings['departmentIds']) =>
  a === b ||
  (a !== 'all' &&
    b !== 'all' &&
    a.length === b.length &&
    [...a].sort().join() === [...b].sort().join());

export class PortalAdminService {
  readonly #repository: PortalAdminRepository;
  readonly #db: Db;

  constructor(repository: PortalAdminRepository, db: Db) {
    this.#repository = repository;
    this.#db = db;
  }

  // ----------------------------------------------------------------- settings

  /**
   * Replaces `settings.portal` and nothing else in the brand's settings, and
   * drops the brand's cached help center pages in the same transaction (through
   * the outbox, `site/cache-events.ts`) so the header changes at once.
   */
  async updateSettings(
    context: PortalAdminContext,
    request: PortalSettingsUpdate,
  ): Promise<PortalSettings> {
    const { tx, brandId } = context;
    const current = await this.#repository.brandSettings(tx, brandId);
    /* c8 ignore next 3 -- the permission guard resolved this brand from a role in it. */
    if (current === undefined) {
      throw new NotFoundException('No such brand');
    }

    if (request.departmentIds !== 'all') {
      const known = await this.#repository.countDepartments(tx, request.departmentIds);
      if (known !== request.departmentIds.length) {
        // A department of another brand is invisible to this transaction, so
        // "no such id" and "not yours" are the same answer.
        throw new BadRequestException('A department listed is not a department of this brand');
      }
    }

    const before = current.portal;
    const after: PortalSettings = { ...request };
    const changed = (['enabled', 'newCustomers', 'departmentIds'] as const).filter((key) =>
      key === 'departmentIds'
        ? !sameDepartments(before.departmentIds, after.departmentIds)
        : before[key] !== after[key],
    );
    if (changed.length === 0) {
      return before;
    }

    await this.#repository.writeBrandSettings(
      tx,
      brandId,
      parseBrandSettings({ ...current, portal: after }),
    );
    await this.#repository.audit(tx, {
      brandId,
      actorId: context.actorId,
      action: 'brand.portal.updated',
      targetType: 'brand',
      targetId: brandId,
      meta: {
        before: Object.fromEntries(changed.map((key) => [key, before[key]])),
        after: Object.fromEntries(changed.map((key) => [key, after[key]])),
      },
    });
    await enqueueSiteChanged(tx, brandId, 'portal');

    return after;
  }

  // ------------------------------------------------------------------ account

  async accountPortal(context: PortalAdminContext, accountId: string): Promise<AccountPortal> {
    const account = await this.#requireAccount(context.tx, accountId);

    return this.#accountView(context.tx, account.id, account.visibility);
  }

  async updateAccountPortal(
    context: PortalAdminContext,
    accountId: string,
    request: AccountPortalUpdate,
  ): Promise<AccountPortal> {
    const { tx, brandId } = context;
    const account = await this.#requireAccount(tx, accountId);
    const members = await this.#repository.members(tx, accountId);
    const memberIds = new Set(members.map((member) => member.contactId));
    if (!request.managerContactIds.every((id) => memberIds.has(id))) {
      throw new BadRequestException('A manager must be a contact of this account');
    }

    const managersBefore = members
      .filter((member) => member.role === 'manager')
      .map((member) => member.contactId);
    const managersAfter = [...request.managerContactIds];
    const added = managersAfter.filter((id) => !managersBefore.includes(id));
    const removed = managersBefore.filter((id) => !managersAfter.includes(id));

    if (request.visibility !== account.visibility) {
      await this.#repository.setVisibility(tx, accountId, request.visibility);
    }
    if (added.length > 0 || removed.length > 0) {
      await this.#repository.setRoles(tx, accountId, managersAfter);
    }

    if (request.visibility !== account.visibility || added.length > 0 || removed.length > 0) {
      await this.#repository.audit(tx, {
        brandId,
        actorId: context.actorId,
        action: 'account.portal.updated',
        targetType: 'account',
        targetId: accountId,
        meta: {
          ...(request.visibility === account.visibility
            ? {}
            : {
                before: { visibility: account.visibility },
                after: { visibility: request.visibility },
              }),
          managersAdded: added,
          managersRemoved: removed,
        },
      });
    }

    return this.#accountView(tx, accountId, request.visibility);
  }

  // ------------------------------------------------------------------ contact

  async contactAccess(
    context: PortalAdminContext,
    contactId: string,
  ): Promise<ContactPortalAccess> {
    const { tx } = context;
    const contact = await this.#requireContact(tx, contactId);
    const sessions = await this.#repository.sessions(tx, contactId, new Date());
    const facts = {
      hasAccount: contact.hasAccount,
      visibility: contact.visibility,
      role: contact.role,
    };

    return {
      signedIn: sessions.length > 0,
      signsInWith: sessions[0]?.email ?? null,
      sees: customerSees(facts),
      seesBecause: portalSeesBecause(facts),
      sessions: sessions.map((session) => ({
        id: session.id,
        userAgentFamily: session.userAgentFamily,
        lastSeenAt: session.lastSeenAt.toISOString(),
        host: session.host,
      })),
    };
  }

  /**
   * Ends every portal session of one contact. The session table accepts writes
   * from the explicit system path alone (M21-01), so the delete runs in its own
   * transaction as the system principal, after this request's transaction has
   * proved the contact is one of the brand's. The count is audited, never a
   * session.
   */
  async signOut(context: PortalAdminContext, contactId: string): Promise<ContactPortalSignOut> {
    const { tx, brandId } = context;
    await this.#requireContact(tx, contactId);

    const ended = await withTenant(
      this.#db,
      systemContext(brandId, SIGN_OUT_JOB_ID),
      async (system) => await this.#repository.deleteSessions(system, brandId, contactId),
    );
    await this.#repository.audit(tx, {
      brandId,
      actorId: context.actorId,
      action: 'contact.portal.signed_out',
      targetType: 'contact',
      targetId: contactId,
      meta: { sessionsEnded: ended },
    });

    return { ended };
  }

  // ------------------------------------------------------------------- ticket

  /** The private mark. A ticket outside the agent's departments is a 404, as on every ticket write. */
  async setPortalPrivate(
    context: PortalAdminContext,
    ticketId: string,
    value: boolean,
  ): Promise<TicketPortalView> {
    const { tx, brandId, principal } = context;
    const ticket = await this.#repository.ticket(tx, ticketId);
    if (ticket === undefined) {
      throw new NotFoundException('No such ticket');
    }
    if (ticket.portalPrivate === value) {
      return readTicketPortalView(tx, ticket);
    }

    await this.#repository.setPortalPrivate(tx, ticketId, value);
    await writeTicketActivity(tx, {
      brandId,
      ticketId,
      departmentId: ticket.departmentId,
      actor: activityActorFor(principal),
      action: 'ticket.portal_private.changed',
      from: { private: ticket.portalPrivate },
      to: { private: value },
    });
    await this.#repository.audit(tx, {
      brandId,
      actorId: context.actorId,
      action: 'ticket.portal_private.changed',
      targetType: 'ticket',
      targetId: ticketId,
      meta: { before: { private: ticket.portalPrivate }, after: { private: value } },
    });
    await enqueueTicketEvent(tx, brandId, TICKET_EVENTS.updated, {
      ticketId,
      departmentId: ticket.departmentId,
    });

    return readTicketPortalView(tx, { ...ticket, portalPrivate: value });
  }

  // ---------------------------------------------------------------- internals

  async #accountView(
    tx: DbTransaction,
    accountId: string,
    visibility: AccountPortal['visibility'],
  ): Promise<AccountPortal> {
    const members = await this.#repository.members(tx, accountId);

    return {
      visibility,
      members: members.map((member) => ({
        contactId: member.contactId,
        name: member.name,
        email: member.email,
        role: member.role,
        lastSignInAt: member.lastSeenAt?.toISOString() ?? null,
      })),
    };
  }

  async #requireAccount(tx: DbTransaction, accountId: string) {
    const account = await this.#repository.account(tx, accountId);
    if (account === undefined) {
      throw new NotFoundException('No such account');
    }

    return account;
  }

  async #requireContact(tx: DbTransaction, contactId: string) {
    const contact = await this.#repository.contact(tx, contactId);
    if (contact === undefined) {
      throw new NotFoundException('No such contact');
    }

    return contact;
  }
}
