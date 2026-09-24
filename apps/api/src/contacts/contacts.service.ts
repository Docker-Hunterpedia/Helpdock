import type { Settings } from '@helpdock/config';
import type {
  Account as AccountRow,
  ContactIdentity as ContactIdentityRow,
  Contact as ContactRow,
  DbTransaction,
} from '@helpdock/db';
import type {
  ContactCreateRequest,
  ContactDetail,
  ContactIdentityInput,
  ContactIdentityKind,
  ContactList,
  ContactNote,
  ContactNoteRequest,
  ContactSearchQuery,
  ContactStats,
  ContactSummary,
  ContactTimeline,
  ContactUpdateRequest,
} from '@helpdock/schemas';
import { CONTACT_PAGE_SIZE } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { mergeCustomValues, parseCustomValues } from '../ticketing/custom-values.js';
import { ERASED_CONTACT_NAME, erasedIdentityValue, erasureSummary } from './anonymise.js';
import { writeContactAudit } from './audit.js';
import { ContactFailure } from './contact-failure.js';
import { byContact, duplicateView, identityView, noteView, summaryView } from './contact-view.js';
import type { ContactsRepository } from './contacts.repository.js';
import {
  assertVerifiable,
  findByIdentity,
  insertContact,
  insertIdentity,
  requireNormalised,
} from './identity.js';
import {
  type ContactErasureProvider,
  type ContactTimelineProvider,
  NoContactErasureProvider,
  type TicketStatsProvider,
} from './providers.js';

/**
 * Contacts and accounts for one brand (M1-04).
 *
 * Three rules run through every method:
 *
 * - **Nothing filters by brand.** The transaction the request opened carries
 *   the brand in `app.brand_ids` and the policies do the filtering
 *   (DOMAIN-RULES §1.3). A contact of another brand is not "not found" here; it
 *   does not exist here.
 * - **An identifier is normalised once**, at the edge, by
 *   `@helpdock/schemas`. Nothing below this line compares a raw string.
 * - **An erased contact is immutable.** DOMAIN-RULES §11 is a one-way door, and
 *   editing what is left of one would be a way to put something back.
 */

export interface ContactActor {
  readonly userId: string;
  readonly role: 'admin' | 'team_leader' | 'agent' | 'viewer';
}

export interface ContactContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actor: ContactActor;
}

export interface ContactsServiceOptions {
  readonly repository: ContactsRepository;
  readonly settings: Settings;
  readonly stats: TicketStatsProvider;
  readonly timeline: ContactTimelineProvider;
  /** What an erasure removes from tickets. Defaults to nothing, for a brand with none. */
  readonly erasure?: ContactErasureProvider;
}

export class ContactsService {
  readonly #repository: ContactsRepository;
  readonly #settings: Settings;
  readonly #stats: TicketStatsProvider;
  readonly #timeline: ContactTimelineProvider;
  readonly #erasure: ContactErasureProvider;

  constructor({
    repository,
    settings,
    stats,
    timeline,
    erasure = new NoContactErasureProvider(),
  }: ContactsServiceOptions) {
    this.#repository = repository;
    this.#settings = settings;
    this.#erasure = erasure;
    this.#stats = stats;
    this.#timeline = timeline;
  }

  async list(context: ContactContext, query: ContactSearchQuery): Promise<ContactList> {
    const { tx } = context;
    const page = await this.#repository.list(tx, {
      search: query.search,
      accountId: query.accountId,
      duplicatesOnly: query.duplicates,
      cursor: query.cursor,
      limit: query.limit ?? CONTACT_PAGE_SIZE,
    });

    const summaries = await this.#summaries(context, page.rows);
    const filtered =
      query.hasOpenTickets === true
        ? await this.#withOpenTickets(context, summaries)
        : { contacts: summaries, total: page.total, nextCursor: page.nextCursor };

    return {
      ...filtered,
      duplicateCount: await this.#repository.countOpenDuplicates(tx),
    };
  }

  async detail(context: ContactContext, contactId: string): Promise<ContactDetail> {
    const { tx } = context;
    const contact = await this.#require(tx, contactId);
    const identities = await this.#repository.identitiesOf(tx, [contactId]);
    const account =
      contact.accountId === null
        ? undefined
        : await this.#repository.account(tx, contact.accountId);
    const [stats] = await this.#statsFor(context, [contactId]);

    return {
      ...summaryView(contact, { identities, account, stats: stats ?? undefined }),
      locale: contact.locale,
      timezone: contact.timezone,
      externalId: contact.externalId,
      custom: contact.custom,
      identities: identities.map(identityView),
      notes: await this.#notes(tx, contactId),
      duplicates: await this.#duplicates(tx, contact),
    };
  }

  /**
   * The timeline, straight from the provider. `hiddenCount` is the whole of
   * DOMAIN-RULES §1.2's promise: the agent learns that history exists in a
   * department they are not in, and nothing about what is in it.
   */
  async timeline(context: ContactContext, contactId: string): Promise<ContactTimeline> {
    const { tx, brandId } = context;
    const contact = await this.#require(tx, contactId);
    const result = await this.#timeline.forContact(tx, brandId, contact.id);

    return {
      items: [...result.items],
      notes: await this.#notes(tx, contactId),
      hiddenCount: result.hiddenCount,
    };
  }

  async create(context: ContactContext, request: ContactCreateRequest): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    const claims = await this.#normaliseAll(request.identities);

    await this.#requireAccount(tx, request.accountId ?? null);

    const contact = await insertContact(tx, {
      brandId,
      name: request.name,
      accountId: request.accountId ?? null,
      locale: request.locale ?? null,
      timezone: request.timezone ?? null,
      externalId: request.externalId ?? null,
    });

    for (const claim of claims) {
      // The request is one transaction, so a refusal here takes the half-made
      // contact with it.
      await this.#attach(context, contact, claim);
    }

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.created',
      targetType: 'contact',
      targetId: contact.id,
      meta: { kinds: claims.map((claim) => claim.kind) },
    });

    return this.detail(context, contact.id);
  }

  async update(
    context: ContactContext,
    contactId: string,
    request: ContactUpdateRequest,
  ): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    const contact = await this.#require(tx, contactId);
    this.#refuseIfErased(contact);

    await this.#requireAccount(tx, request.accountId ?? null);

    // M1-06: a patch over the stored `custom` object, validated against the
    // brand's *contact* definitions. One function for all three targets, so a
    // brand's fields mean the same thing on a contact as on a ticket
    // (`ticketing/custom-values.ts`).
    const custom =
      request.custom === undefined
        ? undefined
        : mergeCustomValues(
            contact.custom,
            (await parseCustomValues(tx, 'contact', request.custom, { partial: true })) ?? {},
          );

    const changes = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.accountId === undefined ? {} : { accountId: request.accountId ?? null }),
      ...(request.locale === undefined ? {} : { locale: request.locale ?? null }),
      ...(request.timezone === undefined ? {} : { timezone: request.timezone ?? null }),
      ...(request.externalId === undefined ? {} : { externalId: request.externalId ?? null }),
      ...(custom === undefined ? {} : { custom }),
    };

    await this.#repository.updateContact(tx, contactId, changes);
    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.updated',
      targetType: 'contact',
      targetId: contactId,
      meta: { fields: Object.keys(changes) },
    });

    return this.detail(context, contactId);
  }

  async addIdentity(
    context: ContactContext,
    contactId: string,
    input: ContactIdentityInput,
  ): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    const contact = await this.#require(tx, contactId);
    this.#refuseIfErased(contact);

    const [claim] = await this.#normaliseAll([input]);
    /* c8 ignore next 3 -- one input in, one claim out. */
    if (claim === undefined) {
      throw new ContactFailure('identity-invalid', 'empty');
    }

    await this.#attach(context, contact, claim);
    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.identity.added',
      targetType: 'contact',
      targetId: contactId,
      meta: { kind: claim.kind },
    });

    return this.detail(context, contactId);
  }

  async removeIdentity(
    context: ContactContext,
    contactId: string,
    identityId: string,
  ): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    const contact = await this.#require(tx, contactId);
    this.#refuseIfErased(contact);

    const identity = await this.#repository.identity(tx, identityId);
    if (identity === undefined || identity.contactId !== contactId) {
      throw new NotFoundException('No such identifier on this contact');
    }

    if ((await this.#repository.countIdentities(tx, contactId)) <= 1) {
      throw new ContactFailure('last-identity');
    }

    await this.#repository.deleteIdentity(tx, identityId);
    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.identity.removed',
      targetType: 'contact',
      targetId: contactId,
      meta: { kind: identity.kind },
    });

    return this.detail(context, contactId);
  }

  async addNote(
    context: ContactContext,
    contactId: string,
    request: ContactNoteRequest,
  ): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    const contact = await this.#require(tx, contactId);
    this.#refuseIfErased(contact);

    const note = await this.#repository.insertNote(tx, {
      brandId,
      contactId,
      authorId: actor.userId,
      bodyText: request.bodyText,
    });

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.note.added',
      targetType: 'contact',
      targetId: contactId,
      // The body is what an agent wrote about a customer, so it stays in the
      // table it was written to; the audit row records that a note happened.
      meta: { noteId: note.id },
    });

    return this.detail(context, contactId);
  }

  async dismissDuplicate(
    context: ContactContext,
    contactId: string,
    suggestionId: string,
  ): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    await this.#require(tx, contactId);

    const suggestion = await this.#repository.duplicate(tx, suggestionId);
    if (
      suggestion === undefined ||
      (suggestion.contactId !== contactId && suggestion.otherContactId !== contactId)
    ) {
      throw new NotFoundException('No such duplicate suggestion on this contact');
    }

    if (await this.#repository.dismissDuplicate(tx, suggestionId)) {
      await writeContactAudit(tx, {
        brandId,
        actorId: actor.userId,
        action: 'contact.duplicate.dismissed',
        targetType: 'contact',
        targetId: contactId,
        meta: { suggestionId, reason: suggestion.reason },
      });
    }

    return this.detail(context, contactId);
  }

  /**
   * DOMAIN-RULES §11's erasure. Admin only, in this brand: `contact:write`
   * buys an edit, and this is not an edit — it destroys history that no
   * permission can give back. The audit row names the contact and counts what
   * went, and carries no value of any kind.
   */
  async anonymise(context: ContactContext, contactId: string): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    if (actor.role !== 'admin') {
      throw new ContactFailure('anonymise-forbidden');
    }

    const contact = await this.#require(tx, contactId);
    this.#refuseIfErased(contact);

    const identities = await this.#repository.identitiesOf(tx, [contactId]);
    const erased = await this.#repository.anonymise(tx, contactId, {
      name: ERASED_CONTACT_NAME,
      identities: identities.map((identity) => ({
        id: identity.id,
        value: erasedIdentityValue(contactId, identity.kind),
      })),
    });

    /* c8 ignore next 3 -- `#refuseIfErased` has already answered for this case. */
    if (!erased) {
      throw new ContactFailure('anonymised');
    }

    // The files they sent and the channel ids of what they wrote (M1-14). Ticket
    // bodies stay: §11 keeps them "unless the brand's ticket retention says
    // otherwise", and that is the nightly purge's decision, not this one's.
    const traces = await this.#erasure.eraseTraces(tx, brandId, contactId);

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.anonymised',
      targetType: 'contact',
      targetId: contactId,
      meta: {
        ...erasureSummary({
          kinds: identities.map((identity) => identity.kind),
          noteCount: contact.notesCount,
          hadAccount: contact.accountId !== null,
          hadExternalId: contact.externalId !== null,
        }),
        attachmentCount: traces.attachments,
        messageCount: traces.messages,
      },
    });

    return this.detail(context, contactId);
  }

  // ------------------------------------------------------------------

  /**
   * Attaches one identifier an agent typed.
   *
   * A value another contact already holds is **refused**, not turned into a
   * duplicate suggestion. The suggestion of DOMAIN-RULES §4.4 exists because a
   * channel has nobody at the keyboard to ask; an agent filling a form can see
   * the clash and fix it, and a duplicate made on purpose is not one anybody
   * should have to review later. The channel path is
   * `findOrCreateContactByIdentity`, and it is the only thing that suggests.
   */
  async #attach(
    context: ContactContext,
    contact: ContactRow,
    claim: NormalisedClaim,
  ): Promise<ContactIdentityRow> {
    const { tx, brandId } = context;
    const existing = await findByIdentity(tx, brandId, claim.kind, claim.value);

    if (existing !== undefined) {
      if (existing.contactId !== contact.id) {
        throw new ContactFailure('identity-taken');
      }

      return existing;
    }

    return insertIdentity(tx, {
      brandId,
      contactId: contact.id,
      kind: claim.kind,
      value: claim.value,
      // Nothing an agent types is proof (DOMAIN-RULES §4). The channels that
      // can prove one go through `findOrCreateContactByIdentity` instead.
      verified: false,
      source: 'agent',
    });
  }

  /**
   * `contacts.defaultCallingCode` is declared `scope: 'brand'`, so it becomes a
   * per-brand value the moment the per-brand resolution rule lands (it is the
   * open gap in `packages/db/README.md`). Until then `Settings.get` answers
   * install-wide, which is the same value for a single-brand install and is
   * never a *wrong* code — an install that supports two countries leaves it
   * empty and gets ADR 0008's refusal instead of a guess.
   */
  async #normaliseAll(inputs: readonly ContactIdentityInput[]): Promise<NormalisedClaim[]> {
    const callingCode = await this.#settings.get('contacts.defaultCallingCode');

    return inputs.map((input) => {
      assertVerifiable(input.kind, false);

      return { kind: input.kind, value: requireNormalised(input.kind, input.value, callingCode) };
    });
  }

  async #require(tx: DbTransaction, contactId: string): Promise<ContactRow> {
    const contact = await this.#repository.find(tx, contactId);
    if (contact === undefined) {
      throw new NotFoundException('No such contact');
    }

    return contact;
  }

  #refuseIfErased(contact: ContactRow): void {
    if (contact.anonymisedAt !== null) {
      throw new ContactFailure('anonymised');
    }
  }

  /** A 404 rather than a foreign-key error when the account is another brand's. */
  async #requireAccount(tx: DbTransaction, accountId: string | null): Promise<void> {
    if (accountId !== null && (await this.#repository.account(tx, accountId)) === undefined) {
      throw new NotFoundException('No such account');
    }
  }

  async #summaries(
    context: ContactContext,
    rows: readonly ContactRow[],
  ): Promise<ContactSummary[]> {
    const { tx } = context;
    const ids = rows.map((row) => row.id);
    const identities = byContact(await this.#repository.identitiesOf(tx, ids));
    const accountIds = [
      ...new Set(rows.map((row) => row.accountId).filter((id): id is string => id !== null)),
    ];
    const accounts = new Map(
      (await this.#repository.accountsByIds(tx, accountIds)).map((row) => [row.id, row]),
    );
    const stats = await this.#stats.forContacts(tx, context.brandId, ids);

    return rows.map((row) =>
      summaryView(row, {
        identities: identities.get(row.id) ?? [],
        account: row.accountId === null ? undefined : accounts.get(row.accountId),
        stats: stats.get(row.id),
      }),
    );
  }

  async #statsFor(
    context: ContactContext,
    ids: readonly string[],
  ): Promise<(ContactStats | undefined)[]> {
    const stats = await this.#stats.forContacts(context.tx, context.brandId, ids);

    return ids.map((id) => stats.get(id));
  }

  /**
   * The "Has open tickets" chip. The provider answers `null` while there are no
   * tickets to count, and the filter then narrows nothing — a chip that hid
   * every row would look like a broken list rather than an honest zero.
   */
  async #withOpenTickets(
    context: ContactContext,
    summaries: readonly ContactSummary[],
  ): Promise<{ contacts: ContactSummary[]; total: number; nextCursor: string | null }> {
    const allowed = await this.#stats.withOpenTickets(
      context.tx,
      context.brandId,
      summaries.map((summary) => summary.id),
    );

    const contacts =
      allowed === null
        ? [...summaries]
        : summaries.filter((summary) => allowed.includes(summary.id));

    // A filter applied after the page was read cannot claim a total for the
    // whole brand, so it reports what it is showing.
    return { contacts, total: contacts.length, nextCursor: null };
  }

  async #notes(tx: DbTransaction, contactId: string): Promise<ContactNote[]> {
    const rows = await this.#repository.notesOf(tx, contactId);

    return rows.map(({ note, author }) => noteView(note, author));
  }

  async #duplicates(tx: DbTransaction, contact: ContactRow) {
    const rows = await this.#repository.duplicatesOf(tx, contact.id);
    const otherIdentities = byContact(
      await this.#repository.identitiesOf(
        tx,
        rows.map(({ other }) => other.id),
      ),
    );
    const accounts = new Map<string, AccountRow>(
      (
        await this.#repository.accountsByIds(tx, [
          ...new Set(
            rows.map(({ other }) => other.accountId).filter((id): id is string => id !== null),
          ),
        ])
      ).map((row) => [row.id, row]),
    );

    return rows.map(({ suggestion, other }) =>
      duplicateView(suggestion, {
        other,
        otherIdentities: otherIdentities.get(other.id) ?? [],
        otherAccount: other.accountId === null ? undefined : accounts.get(other.accountId),
        sameAccount: other.accountId !== null && other.accountId === contact.accountId,
      }),
    );
  }
}

interface NormalisedClaim {
  readonly kind: ContactIdentityKind;
  readonly value: string;
}
