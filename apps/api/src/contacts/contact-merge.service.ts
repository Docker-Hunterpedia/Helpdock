import type { Contact as ContactRow } from '@helpdock/db';
import type {
  ContactDetail,
  ContactMergePreview,
  ContactMergeRequest,
  ContactMergeSide,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { writeContactAudit } from './audit.js';
import { ContactFailure } from './contact-failure.js';
import type { ContactMergesRepository } from './contact-merges.repository.js';
import { identityView } from './contact-view.js';
import type { ContactsRepository } from './contacts.repository.js';
import type { ContactContext, ContactsService } from './contacts.service.js';

/**
 * Merging two contacts by hand, and the 24-hour undo (M1-13, DOMAIN-RULES
 * §4.4).
 *
 * What a merge does, in one transaction:
 *
 * - The **survivor** keeps its name and details; the agent chose it in the
 *   dialog, so nothing of the other contact's profile is copied over.
 * - Identifiers move to the survivor **as they are**. Verification never
 *   upgrades by merging: an address somebody typed stays unverified beside a
 *   verified one, because a merge is an agent's judgement, not proof.
 * - Notes and **all** tickets move, including tickets in departments the agent
 *   cannot see (a contact is brand-scoped, §1.2). Tickets are not merged with
 *   each other — that is a different decision (§2.4).
 * - The merged contact stays as a row with `merged_into_id`, which is what
 *   makes the undo possible and what old message author ids still point at.
 * - One `contact_merges` row names exactly what moved, and one audit entry
 *   records it.
 *
 * Undo moves back exactly what the merge moved — a ticket the survivor gained
 * since stays — and is refused once the 24 hours are up, and whenever the
 * contacts have changed in a way an undo would have to guess about.
 */
export class ContactMergeService {
  readonly #merges: ContactMergesRepository;
  readonly #contacts: ContactsRepository;
  readonly #detail: Pick<ContactsService, 'detail'>;

  constructor({
    merges,
    contacts,
    detail,
  }: {
    readonly merges: ContactMergesRepository;
    readonly contacts: ContactsRepository;
    readonly detail: Pick<ContactsService, 'detail'>;
  }) {
    this.#merges = merges;
    this.#contacts = contacts;
    this.#detail = detail;
  }

  /** What the dialog draws: both sides, and the identifiers the survivor will hold. */
  async preview(
    context: ContactContext,
    contactId: string,
    otherContactId: string,
  ): Promise<ContactMergePreview> {
    const { tx } = context;
    const [contact, other] = await Promise.all([
      this.#requireMergeable(context, contactId),
      this.#requireMergeable(context, otherContactId),
    ]);
    if (contact.id === other.id) {
      throw new ContactFailure('merge-self');
    }

    const identities = await this.#contacts.identitiesOf(tx, [contact.id, other.id]);

    return {
      contact: await this.#side(context, contact),
      other: await this.#side(context, other),
      identities: identities.map((row) => ({ ...identityView(row), contactId: row.contactId })),
    };
  }

  async merge(
    context: ContactContext,
    survivorId: string,
    request: ContactMergeRequest,
  ): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    if (survivorId === request.mergedContactId) {
      throw new ContactFailure('merge-self');
    }

    const locked = await this.#merges.lockPair(tx, [survivorId, request.mergedContactId]);
    const survivor = requireMergeableRow(locked, survivorId);
    const merged = requireMergeableRow(locked, request.mergedContactId);

    const suggestionId =
      request.suggestionId ?? (await this.#merges.openSuggestionFor(tx, survivor.id, merged.id));
    if (request.suggestionId !== undefined) {
      await this.#requireSuggestion(context, request.suggestionId, survivor.id, merged.id);
    }

    const movedIdentityIds = await this.#merges.moveIdentities(tx, {
      from: merged.id,
      to: survivor.id,
    });
    const movedNoteIds = await this.#merges.moveNotes(tx, { from: merged.id, to: survivor.id });
    const movedTicketIds = await this.#merges.moveTickets(tx, {
      brandId,
      from: merged.id,
      to: survivor.id,
    });
    await this.#merges.markMerged(tx, merged.id, survivor.id);
    await this.#merges.setPairSuggestions(tx, {
      a: survivor.id,
      b: merged.id,
      from: 'open',
      to: 'merged',
    });

    const merge = await this.#merges.insert(tx, {
      brandId,
      survivorId: survivor.id,
      mergedId: merged.id,
      suggestionId: suggestionId ?? null,
      actorId: actor.userId,
      movedIdentityIds,
      movedTicketIds,
      movedNoteIds,
    });

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.merged',
      targetType: 'contact',
      targetId: survivor.id,
      // Counts and ids only: the identifiers themselves are personal data and
      // stay in the table they belong to (`audit.ts`).
      meta: {
        mergeId: merge.id,
        mergedContactId: merged.id,
        identityCount: movedIdentityIds.length,
        ticketCount: movedTicketIds.length,
        noteCount: movedNoteIds.length,
      },
    });

    return this.#detail.detail(context, survivor.id);
  }

  async undo(context: ContactContext, survivorId: string, mergeId: string): Promise<ContactDetail> {
    const { tx, brandId, actor } = context;
    const merge = await this.#merges.find(tx, survivorId, mergeId);
    if (merge === undefined) {
      throw new NotFoundException('No such merge into this contact');
    }
    if (merge.undoneAt !== null || merge.undoUntil.getTime() <= Date.now()) {
      throw new ContactFailure('merge-expired');
    }

    const locked = await this.#merges.lockPair(tx, [merge.survivorId, merge.mergedId]);
    const survivor = locked.find((row) => row.id === merge.survivorId);
    const merged = locked.find((row) => row.id === merge.mergedId);
    // The survivor merged onwards, or either side erased since: moving rows
    // back would mean guessing which of them are still the ones this merge
    // moved, so the undo is refused instead.
    if (
      survivor === undefined ||
      merged === undefined ||
      survivor.mergedIntoId !== null ||
      survivor.anonymisedAt !== null ||
      merged.anonymisedAt !== null ||
      merged.mergedIntoId !== survivor.id
    ) {
      throw new ContactFailure('merge-blocked');
    }

    const identityCount = (
      await this.#merges.moveIdentities(tx, {
        from: survivor.id,
        to: merged.id,
        ids: merge.movedIdentityIds,
      })
    ).length;
    await this.#merges.moveNotes(tx, { from: survivor.id, to: merged.id, ids: merge.movedNoteIds });
    const ticketCount = (
      await this.#merges.moveTickets(tx, {
        brandId,
        from: survivor.id,
        to: merged.id,
        ids: merge.movedTicketIds,
      })
    ).length;
    await this.#merges.markMerged(tx, merged.id, null);
    await this.#merges.setPairSuggestions(tx, {
      a: survivor.id,
      b: merged.id,
      from: 'merged',
      to: 'open',
    });
    await this.#merges.markUndone(tx, merge.id, actor.userId);

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'contact.merge.undone',
      targetType: 'contact',
      targetId: survivor.id,
      meta: { mergeId: merge.id, mergedContactId: merged.id, identityCount, ticketCount },
    });

    return this.#detail.detail(context, survivor.id);
  }

  // ------------------------------------------------------------------

  async #side(context: ContactContext, contact: ContactRow): Promise<ContactMergeSide> {
    const account =
      contact.accountId === null
        ? undefined
        : await this.#contacts.account(context.tx, contact.accountId);

    return {
      id: contact.id,
      name: contact.name,
      accountName: account?.name ?? null,
      ticketCount: await this.#merges.ticketCount(context.tx, context.brandId, contact.id),
    };
  }

  async #requireMergeable(context: ContactContext, contactId: string): Promise<ContactRow> {
    const contact = await this.#contacts.find(context.tx, contactId);

    return requireMergeableRow(contact === undefined ? [] : [contact], contactId);
  }

  async #requireSuggestion(
    context: ContactContext,
    suggestionId: string,
    a: string,
    b: string,
  ): Promise<void> {
    const suggestion = await this.#contacts.duplicate(context.tx, suggestionId);
    const pair = new Set([suggestion?.contactId, suggestion?.otherContactId]);
    if (suggestion === undefined || !pair.has(a) || !pair.has(b)) {
      throw new NotFoundException('No such duplicate suggestion for these contacts');
    }
  }
}

/**
 * The contact, if it may take part in a merge. An erased contact may not — M1-14
 * made it nobody, and merging nobody into somebody would put the erased
 * history back on a real person — and nor may one already merged elsewhere.
 */
const requireMergeableRow = (rows: readonly ContactRow[], contactId: string): ContactRow => {
  const contact = rows.find((row) => row.id === contactId);
  if (contact === undefined) {
    throw new NotFoundException('No such contact');
  }
  if (contact.anonymisedAt !== null) {
    throw new ContactFailure('anonymised');
  }
  if (contact.mergedIntoId !== null) {
    throw new ContactFailure('merged');
  }

  return contact;
};
