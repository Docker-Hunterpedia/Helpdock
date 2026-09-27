import { decryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, contacts, type DbTransaction, type WidgetVisitor } from '@helpdock/db';
import type { SignedIdentity, WidgetSession, WidgetSessionRequest } from '@helpdock/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import { ContactFailure } from '../contacts/contact-failure.js';
import { attachUnverifiedIdentity, findOrCreateContactByIdentity } from '../contacts/identity.js';
import type { Logger } from '../logging/logger.js';
import {
  checkSignedIdentity,
  hashVisitorSecret,
  issueVisitorSecret,
} from './visitor-credential.js';
import type { WidgetRepository } from './widget.repository.js';
import type { WidgetGate, WidgetRequestFacts, WidgetScope } from './widget-gate.js';

/**
 * `POST /api/widget/:brandId/session` (M4-02; DOMAIN-RULES §4.1–4.2).
 *
 * - **No secret, or one this brand does not know** → a new visitor, and the
 *   secret in the response, once. "Clearing storage means a new anonymous
 *   visitor; the old conversations are not reachable."
 * - **A signed identity** → checked against the brand's signing secret and
 *   the five-minute window. Valid: the contact holding that `external_id` —
 *   verified, so found or created by the identity rules of §4.4 — becomes the
 *   visitor's verified contact, which opens that contact's widget
 *   conversations on this device. Invalid: the visitor stays anonymous and a
 *   security event is logged and audited.
 * - **No identity** → any earlier link is cleared, so a person who signed out
 *   of the host site is signed out of the verified history on the next load.
 */
export class WidgetSessionService {
  readonly #gate: WidgetGate;
  readonly #widget: WidgetRepository;
  readonly #keyring: Keyring;
  readonly #logger: Logger;

  constructor(deps: {
    readonly gate: WidgetGate;
    readonly widget: WidgetRepository;
    readonly keyring: Keyring;
    readonly logger: Logger;
  }) {
    this.#gate = deps.gate;
    this.#widget = deps.widget;
    this.#keyring = deps.keyring;
    this.#logger = deps.logger;
  }

  session(
    brandId: string,
    facts: WidgetRequestFacts,
    request: WidgetSessionRequest,
    now: Date = new Date(),
  ): Promise<WidgetSession> {
    return this.#gate.session(brandId, facts, async (scope) => {
      const { tx } = scope;
      let issued: string | null = null;
      let visitor = scope.visitor;
      if (visitor === undefined) {
        issued = issueVisitorSecret();
        visitor = await this.#widget.insertVisitor(tx, {
          brandId,
          secretHash: hashVisitorSecret(issued),
        });
      }

      const verifiedContactId = await this.#verifiedContact(scope, visitor, request.identity, now);
      if (verifiedContactId !== visitor.verifiedContactId || issued === null) {
        visitor = await this.#widget.updateVisitor(tx, visitor.id, {
          verifiedContactId,
          lastSeenAt: now,
        });
      }

      if (request.locale !== undefined) {
        await this.#rememberLocale(tx, visitor, request.locale);
      }

      return {
        visitorId: visitor.id,
        visitorSecret: issued,
        verified: visitor.verifiedContactId !== null,
      };
    });
  }

  async #verifiedContact(
    scope: WidgetScope,
    visitor: WidgetVisitor,
    identity: SignedIdentity | undefined,
    now: Date,
  ): Promise<string | null> {
    const { tx, brand, settings } = scope;
    if (
      identity === undefined ||
      !settings.signedIdentityEnabled ||
      settings.signingSecret === null
    ) {
      return null;
    }

    const check = checkSignedIdentity(
      identity,
      decryptSecret(settings.signingSecret, this.#keyring),
      now,
    );
    if (check !== 'valid') {
      // §4.2: "the widget behaves as anonymous and logs a security event". The
      // user id is the site's claim and is recorded; the signature is not.
      this.#logger.warn(
        { brandId: brand.id, visitorId: visitor.id, reason: check },
        'widget signed identity rejected',
      );
      await tx.insert(auditLog).values({
        brandId: brand.id,
        actorType: 'visitor',
        actorId: visitor.id,
        action: 'widget.identity_rejected',
        targetType: 'widget_visitor',
        targetId: visitor.id,
        meta: { reason: check, userId: identity.payload.user_id },
      });
      return null;
    }

    const { payload } = identity;
    const { contact } = await findOrCreateContactByIdentity(
      tx,
      brand.id,
      { kind: 'external', value: payload.user_id, source: 'widget.signed' },
      payload.name === undefined || payload.name === '' ? {} : { name: payload.name },
    );
    // The brand's own label for the person, as the contact screen shows it,
    // when nothing else has set one.
    await tx
      .update(contacts)
      .set({ externalId: payload.user_id })
      .where(and(eq(contacts.id, contact.id), isNull(contacts.externalId)));

    if (payload.email !== undefined && payload.email !== '') {
      // The site vouches for the user id, not for the mailbox: the address is
      // recorded unverified, like one typed into the pre-chat form.
      try {
        await attachUnverifiedIdentity(tx, brand.id, contact.id, {
          kind: 'email',
          value: payload.email,
          source: 'widget.form',
        });
      } catch (error) {
        if (!(error instanceof ContactFailure)) {
          throw error;
        }
      }
    }

    return contact.id;
  }

  async #rememberLocale(
    tx: DbTransaction,
    visitor: WidgetVisitor,
    locale: 'en' | 'ar',
  ): Promise<void> {
    const contactId = visitor.verifiedContactId ?? visitor.contactId;
    if (contactId === null) {
      return;
    }
    await tx
      .update(contacts)
      .set({ locale })
      .where(and(eq(contacts.id, contactId), isNull(contacts.locale)));
  }
}
