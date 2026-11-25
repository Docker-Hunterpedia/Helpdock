import type { Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { CustomerContextError, loadCustomerScope } from './customer-context.js';
import type { ConfirmOutcome, PortalStore } from './portal-site.js';
import {
  asSystem,
  deleteContactSessions,
  deleteSession,
  emailIsHeld,
  ensureContact,
  findEmailOwner,
  insertSession,
  insertSignInToken,
  type LiveSession,
  markIdentityVerified,
  readPortalSettings,
  readSignInToken,
  resolveSession,
  spendSignInToken,
  type TokenState,
} from './portal-store.js';
import { signInExpiry } from './session-rules.js';
import { queueSignInEmail } from './sign-in-email.js';

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

  constructor(options: { readonly db: Db; readonly keyring: Keyring }) {
    this.#db = options.db;
    this.#keyring = options.keyring;
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

  confirm(input: Parameters<PortalStore['confirm']>[0]): Promise<ConfirmOutcome> {
    const { brandId, now } = input;
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
      const owner = await ensureContact(tx, brandId, link.email, {
        create: portal.newCustomers,
        locale: input.locale,
      });
      if (owner === null) {
        // The contact was merged away or erased since the link was sent.
        return { kind: 'expired' };
      }
      await markIdentityVerified(tx, owner.identityId, now);
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

  endSession(brandId: string, sessionId: string): Promise<void> {
    return asSystem(this.#db, brandId, (tx) => deleteSession(tx, sessionId));
  }

  async endAllSessions(brandId: string, contactId: string): Promise<void> {
    await asSystem(this.#db, brandId, (tx) => deleteContactSessions(tx, brandId, contactId));
  }
}
