import type {
  ContactIdentity as ContactIdentityRow,
  Contact as ContactRow,
  DbTransaction,
} from '@helpdock/db';
import { contactDuplicateSuggestions, contactIdentities, contacts } from '@helpdock/db';
import type {
  ContactDuplicateReason,
  ContactIdentityKind,
  IdentitySource,
} from '@helpdock/schemas';
import {
  isVerifiedIdentity,
  normaliseIdentity,
  VERIFIABLE_IDENTITY_KINDS,
} from '@helpdock/schemas';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { ContactFailure } from './contact-failure.js';

/**
 * The seam every channel goes through to turn "an email arrived from
 * mona@example.com" into a contact row — M2 email, M4 widget, M6 Telegram, and
 * the admin form in this milestone.
 *
 * It is one function because DOMAIN-RULES §4.4 is one rule, and a rule
 * implemented three times is three rules. **Auto-merge happens only when both
 * sides of the match are verified** (M1-13):
 *
 * | The claim is | Another contact holds it | What happens |
 * |---|---|---|
 * | verified | verified | that contact is returned (the auto-merge) |
 * | verified | unverified | **a new contact takes the identifier**, plus a duplicate suggestion |
 * | unverified | either | **a new contact**, plus a duplicate suggestion |
 * | either | nobody | a new contact holding the identifier |
 *
 * The middle rows are the ones that matter. "An identifier someone types is a
 * hint, not proof" (DOMAIN-RULES §4): matching on it would let anybody who
 * knows an address walk into that person's history by typing it into a
 * pre-chat form, and it would equally let a typed address pull a real inbound
 * email into the typist's contact. So a hint on either side becomes a
 * suggestion an agent judges. When the claim *is* proof and the holder's is
 * only a hint, the identifier moves to the contact that can prove it — the
 * unique index allows one holder, and it should be the one with the proof.
 *
 * Whether a claim is verified is not the caller's to say: it names its
 * `source`, and `isVerifiedIdentity` answers from DOMAIN-RULES §4.4's table
 * (`identity-rules.ts` in `@helpdock/schemas`).
 */

export interface IdentityClaim {
  readonly kind: ContactIdentityKind;
  /** As it arrived. Normalised here, once, before anything is looked up. */
  readonly value: string;
  /** Where it came from, which decides whether it is verified. */
  readonly source: IdentitySource;
}

export interface FindOrCreateOptions {
  /** The brand's `contacts.defaultCallingCode`, for phone numbers alone. */
  readonly defaultCallingCode?: string;
  /** Used when a contact has to be created. Defaults to the identifier itself. */
  readonly name?: string;
  readonly accountId?: string | null;
}

export interface FindOrCreateResult {
  readonly contact: ContactRow;
  /**
   * Null in exactly one case: the claim was unverified and another contact
   * already holds the value, so the unique index keeps it off this one and
   * `duplicateOf` says who has it.
   */
  readonly identity: ContactIdentityRow | null;
  /** False when an existing contact was matched on a verified identifier. */
  readonly created: boolean;
  /** The contact the new one was suggested as a duplicate of, if any. */
  readonly duplicateOf: string | null;
}

/** Normalises, or throws the refusal the filter turns into a 400. */
export const requireNormalised = (
  kind: ContactIdentityKind,
  value: string,
  defaultCallingCode = '',
): string => {
  const result = normaliseIdentity(kind, value, { defaultCallingCode });
  if (!result.ok) {
    throw new ContactFailure('identity-invalid', result.problem);
  }

  return result.value;
};

/**
 * Whether a caller may claim this identifier is verified. A `false` here is a
 * mistake at the call site rather than a user-facing refusal — no request body
 * reaches it — so it throws a `TypeError`.
 */
export const assertVerifiable = (kind: ContactIdentityKind, verified: boolean): void => {
  if (verified && !VERIFIABLE_IDENTITY_KINDS[kind]) {
    throw new TypeError(`A ${kind} identifier cannot be verified in v1 (DOMAIN-RULES §4.4)`);
  }
};

/** The contact holding this exact identifier in this brand, if any. */
export const findByIdentity = async (
  tx: DbTransaction,
  brandId: string,
  kind: ContactIdentityKind,
  value: string,
): Promise<ContactIdentityRow | undefined> => {
  const rows = await tx
    .select()
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.brandId, brandId),
        eq(contactIdentities.kind, kind),
        eq(contactIdentities.value, value),
      ),
    )
    .limit(1);

  return rows[0];
};

/**
 * Records "these two might be the same person", once per pair **in either
 * direction**. A second form submission from the same typed address is not a
 * second opinion, and an agent's "Not the same" is an answer for the pair — not
 * an invitation to ask again the other way round.
 */
const suggestDuplicate = async (
  tx: DbTransaction,
  {
    brandId,
    contactId,
    otherContactId,
    reason,
  }: {
    readonly brandId: string;
    readonly contactId: string;
    readonly otherContactId: string;
    readonly reason: ContactDuplicateReason;
  },
): Promise<void> => {
  if (contactId === otherContactId) {
    return;
  }

  const existing = await tx
    .select({ id: contactDuplicateSuggestions.id })
    .from(contactDuplicateSuggestions)
    .where(
      or(
        and(
          eq(contactDuplicateSuggestions.contactId, contactId),
          eq(contactDuplicateSuggestions.otherContactId, otherContactId),
        ),
        and(
          eq(contactDuplicateSuggestions.contactId, otherContactId),
          eq(contactDuplicateSuggestions.otherContactId, contactId),
        ),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  await tx
    .insert(contactDuplicateSuggestions)
    .values({ brandId, contactId, otherContactId, reason })
    .onConflictDoNothing({
      target: [
        contactDuplicateSuggestions.brandId,
        contactDuplicateSuggestions.contactId,
        contactDuplicateSuggestions.otherContactId,
      ],
    });
};

/**
 * pg_trgm's `similarity` from which two names under one account read as one
 * person: "Mona K." against "Mona Khalil" scores 0.46 and "M. Khalil" 0.61,
 * while two colleagues who share only a first name stay well below it.
 */
const SIMILAR_NAME_THRESHOLD = 0.4;

/** At most this many name suggestions for one contact, so a large account is not a flood. */
const SIMILAR_NAME_LIMIT = 5;

/**
 * "Same account, similar name" (M1-13): the one duplicate reason no identifier
 * carries. Run whenever a contact lands under an account — created by a channel
 * or by an agent, or moved there — because that is the moment two records of
 * one person become comparable.
 *
 * Merged and erased contacts are never candidates: the first is already
 * somebody else, and the second is nobody.
 */
export const suggestSimilarNames = async (
  tx: DbTransaction,
  brandId: string,
  contact: Pick<ContactRow, 'id' | 'name' | 'accountId'>,
): Promise<void> => {
  if (contact.accountId === null) {
    return;
  }

  const candidates = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, contact.accountId),
        ne(contacts.id, contact.id),
        isNull(contacts.mergedIntoId),
        isNull(contacts.anonymisedAt),
        sql`similarity(lower(${contacts.name}), lower(${contact.name})) >= ${SIMILAR_NAME_THRESHOLD}`,
      ),
    )
    .limit(SIMILAR_NAME_LIMIT);

  for (const candidate of candidates) {
    await suggestDuplicate(tx, {
      brandId,
      contactId: contact.id,
      otherContactId: candidate.id,
      reason: 'similar_name',
    });
  }
};

/**
 * The seam. Runs inside the caller's transaction, so the contact, its
 * identifier and any duplicate suggestion commit together with whatever domain
 * change asked for them — a ticket, a conversation, an inbound message.
 */
export const findOrCreateContactByIdentity = async (
  tx: DbTransaction,
  brandId: string,
  claim: IdentityClaim,
  options: FindOrCreateOptions = {},
): Promise<FindOrCreateResult> => {
  const verified = isVerifiedIdentity(claim.kind, claim.source);
  const value = requireNormalised(claim.kind, claim.value, options.defaultCallingCode);
  const existing = await findByIdentity(tx, brandId, claim.kind, value);

  if (existing !== undefined && verified && existing.verified) {
    return {
      contact: await contactById(tx, brandId, existing.contactId),
      identity: existing,
      created: false,
      duplicateOf: null,
    };
  }

  const name = options.name?.trim();
  const contact = await insertContact(tx, {
    brandId,
    name: name === undefined || name === '' ? value : name,
    accountId: options.accountId ?? null,
  });
  await suggestSimilarNames(tx, brandId, contact);

  if (existing === undefined) {
    const identity = await insertIdentity(tx, {
      brandId,
      contactId: contact.id,
      kind: claim.kind,
      value,
      verified,
      source: claim.source,
    });

    return { contact, identity, created: true, duplicateOf: null };
  }

  await suggestDuplicate(tx, {
    brandId,
    contactId: contact.id,
    otherContactId: existing.contactId,
    reason: claim.kind,
  });

  return {
    contact,
    identity: verified ? await takeVerified(tx, existing.id, contact.id, claim.source) : null,
    created: true,
    duplicateOf: existing.contactId,
  };
};

/**
 * The contact an address belongs to, or a new one holding it, and the address
 * as normalised — for a CC
 * (DOMAIN-RULES §2.5), where the address is somebody to copy in and never a
 * claim about who is asking. Unlike the seam above it matches an unverified
 * holder too: copying an address in grants its contact nothing, so there is no
 * history to protect, and a second contact per CC would be a duplicate made on
 * purpose.
 */
export const findOrCreateByAddress = async (
  tx: DbTransaction,
  brandId: string,
  address: string,
  source: IdentitySource,
): Promise<{ readonly contact: ContactRow; readonly address: string }> => {
  const value = requireNormalised('email', address);
  const existing = await findByIdentity(tx, brandId, 'email', value);
  if (existing !== undefined) {
    return { contact: await contactById(tx, brandId, existing.contactId), address: value };
  }

  const contact = await insertContact(tx, { brandId, name: value });
  await insertIdentity(tx, {
    brandId,
    contactId: contact.id,
    kind: 'email',
    value,
    verified: isVerifiedIdentity('email', source),
    source,
  });

  return { contact, address: value };
};

// --------------------------------------------------------------------------

const contactById = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<ContactRow> => {
  const rows = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.brandId, brandId), eq(contacts.id, contactId)))
    .limit(1);

  const contact = rows[0];
  /* c8 ignore next 3 -- the identity row's foreign key guarantees the contact. */
  if (contact === undefined) {
    throw new Error('A contact identity pointed at a contact that does not exist');
  }

  return contact;
};

export const insertContact = async (
  tx: DbTransaction,
  values: {
    readonly brandId: string;
    readonly name: string;
    readonly accountId?: string | null;
    readonly locale?: 'en' | 'ar' | null;
    readonly timezone?: string | null;
    readonly externalId?: string | null;
  },
): Promise<ContactRow> => {
  const inserted = await tx
    .insert(contacts)
    .values({
      brandId: values.brandId,
      name: values.name,
      accountId: values.accountId ?? null,
      locale: values.locale ?? null,
      timezone: values.timezone ?? null,
      externalId: values.externalId ?? null,
    })
    .returning();

  const contact = inserted[0];
  /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
  if (contact === undefined) {
    throw new Error('The contact could not be created');
  }

  return contact;
};

export const insertIdentity = async (
  tx: DbTransaction,
  values: {
    readonly brandId: string;
    readonly contactId: string;
    readonly kind: ContactIdentityKind;
    readonly value: string;
    readonly verified: boolean;
    readonly source: string;
  },
): Promise<ContactIdentityRow> => {
  const inserted = await tx
    .insert(contactIdentities)
    .values({ ...values, verifiedAt: values.verified ? new Date() : null })
    .returning();

  const identity = inserted[0];
  /* c8 ignore next 3 -- an insert that returns nothing would have thrown. */
  if (identity === undefined) {
    throw new Error('The contact identity could not be created');
  }

  return identity;
};

/**
 * An identifier another contact held unverified, now proven by the claim that
 * created `contactId`: it moves to the contact with the proof and is marked
 * verified there. The previous holder is left a duplicate suggestion instead.
 */
const takeVerified = async (
  tx: DbTransaction,
  identityId: string,
  contactId: string,
  source: string,
): Promise<ContactIdentityRow> => {
  const updated = await tx
    .update(contactIdentities)
    .set({ contactId, verified: true, verifiedAt: new Date(), source })
    .where(eq(contactIdentities.id, identityId))
    .returning();

  const identity = updated[0];
  /* c8 ignore next 3 -- the row was read in this same transaction. */
  if (identity === undefined) {
    throw new Error('The contact identity vanished mid-transaction');
  }

  return identity;
};
