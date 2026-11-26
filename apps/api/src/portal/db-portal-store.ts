import type { Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import type { MediaService } from '../media/media.service.js';
import { CustomerContextError, type CustomerScope, loadCustomerScope } from './customer-context.js';
import { attachmentUrl, listTickets, readTicket } from './db-ticket-reader.js';
import type { ConfirmOutcome, PortalStore } from './portal-site.js';
import {
  asSystem,
  deleteContactSessions,
  deleteSession,
  emailIsHeld,
  findEmailOwner,
  insertSession,
  insertSignInToken,
  type LiveSession,
  readPortalSettings,
  readSignInToken,
  resolveSession,
  resolveSigner,
  spendSignInToken,
  type TokenState,
} from './portal-store.js';
import { signInExpiry } from './session-rules.js';
import { queueSignInEmail } from './sign-in-email.js';
import type { TicketListQuery } from './ticket-list-rules.js';
import type { TicketReference } from './ticket-reference.js';
import type { AttachmentLookup, PortalTicketList, TicketLookup } from './ticket-views.js';

/** Raised inside the confirm transaction to roll it back when no contact may be signed in. */
class NoSigner extends Error {}

/**
 * The portal's store over Postgres (M21-02). Every call runs on the explicit
 * system path (`asSystem`): the customer policies of M21-01 let only that path
 * write `customer_sessions` and `customer_sign_in_tokens`, and a sign-in link is
 * spent before there is a customer to open a customer context for.
 *
 * The link is created and its email queued in one transaction, so an email is
 * never queued for a link that was not stored, nor a link stored for an email
 * that was not queued (DOMAIN-RULES §6).
 */
export class DbPortalStore implements PortalStore {
  readonly #db: Db;
  readonly #keyring: Keyring;
  readonly #media: Pick<MediaService, 'download'>;

  constructor(options: {
    readonly db: Db;
    readonly keyring: Keyring;
    readonly media: Pick<MediaService, 'download'>;
  }) {
    this.#db = options.db;
    this.#keyring = options.keyring;
    this.#media = options.media;
  }

  issueLink(input: Parameters<PortalStore['issueLink']>[0]): Promise<'issued' | 'skipped'> {
    const { brandId, email } = input;
    return asSystem(this.#db, brandId, async (tx) => {
      const portal = await readPortalSettings(tx, brandId);
      if (portal === null) {
        return 'skipped';
      }
      const owner = await findEmailOwner(tx, brandId, email);
      if (owner === null && (!portal.newCustomers || (await emailIsHeld(tx, brandId, email)))) {
        return 'skipped';
      }
      await insertSignInToken(tx, {
        brandId,
        email,
        contactId: owner?.contactId ?? null,
        tokenHash: input.tokenHash,
        expiresAt: signInExpiry(input.now),
      });
      await queueSignInEmail(tx, this.#keyring, {
        brandId,
        to: email,
        url: input.confirmUrl(input.token),
        locale: input.locale,
      });
      return 'issued';
    });
  }

  readLink(brandId: string, token: string, now: Date): Promise<TokenState> {
    return asSystem(this.#db, brandId, (tx) => readSignInToken(tx, brandId, token, now));
  }

  async confirm(input: Parameters<PortalStore['confirm']>[0]): Promise<ConfirmOutcome> {
    const { brandId, now } = input;
    try {
      return await this.#confirm(brandId, now, input);
    } catch (error) {
      if (error instanceof NoSigner) {
        return { kind: 'expired' };
      }
      throw error;
    }
  }

  #confirm(
    brandId: string,
    now: Date,
    input: Parameters<PortalStore['confirm']>[0],
  ): Promise<ConfirmOutcome> {
    return asSystem(this.#db, brandId, async (tx): Promise<ConfirmOutcome> => {
      const portal = await readPortalSettings(tx, brandId);
      if (portal === null) {
        return { kind: 'expired' };
      }
      const link = await readSignInToken(tx, brandId, input.token, now);
      if (link.state !== 'live') {
        return { kind: link.state };
      }
      // One winner when two requests carry the same link.
      if (!(await spendSignInToken(tx, link.id, now))) {
        return { kind: 'used' };
      }
      const owner = await resolveSigner(tx, brandId, link.email, {
        create: portal.newCustomers,
        locale: input.locale,
      });
      if (owner === null) {
        // Nobody may be signed in as this address any more (merged away, erased, or
        // new customers switched off). The spend is rolled back with everything
        // else: a link is never left spent without a session.
        throw new NoSigner();
      }
      await insertSession(tx, {
        brandId,
        contactId: owner.contactId,
        identityId: owner.identityId,
        tokenHash: input.sessionTokenHash,
        host: input.host,
        userAgentFamily: input.userAgentFamily,
        now,
      });
      return { kind: 'signed-in', contactId: owner.contactId };
    });
  }

  async session(input: Parameters<PortalStore['session']>[0]): Promise<LiveSession | null> {
    const live = await asSystem(this.#db, input.brandId, (tx) => resolveSession(tx, input));
    if (live === null) {
      return null;
    }
    try {
      // Refuses a merged or erased contact, a disabled brand and a portal that was turned off.
      const scope = await loadCustomerScope(this.#db, {
        brandId: live.brandId,
        contactId: live.contactId,
      });
      return { ...live, scope };
    } catch (error) {
      if (error instanceof CustomerContextError) {
        return null;
      }
      throw error;
    }
  }

  tickets(session: LiveSession, query: TicketListQuery): Promise<PortalTicketList> {
    return listTickets(this.#db, scopeOf(session), query);
  }

  ticket(session: LiveSession, reference: TicketReference): Promise<TicketLookup> {
    return readTicket(this.#db, scopeOf(session), reference);
  }

  attachment(
    session: LiveSession,
    reference: TicketReference,
    attachmentId: string,
  ): Promise<AttachmentLookup> {
    return attachmentUrl(this.#db, this.#media, scopeOf(session), reference, attachmentId);
  }

  endSession(brandId: string, sessionId: string): Promise<void> {
    return asSystem(this.#db, brandId, (tx) => deleteSession(tx, sessionId));
  }

  async endAllSessions(brandId: string, contactId: string): Promise<void> {
    await asSystem(this.#db, brandId, (tx) => deleteContactSessions(tx, brandId, contactId));
  }
}

/** The scope the guard read on this request; a session without one never reaches a read. */
const scopeOf = (session: LiveSession): CustomerScope => {
  if (session.scope === undefined) {
    throw new Error('A portal read needs the scope the session guard loads');
  }
  return session.scope;
};
