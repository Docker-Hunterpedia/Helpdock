import type {
  ContactIdentity as ContactIdentityRow,
  Contact as ContactRow,
  DbTransaction,
} from '@helpdock/db';
import { contactDuplicateSuggestions, contactIdentities, contacts } from '@helpdock/db';
import type { ContactIdentityKind } from '@helpdock/schemas';
import { normaliseIdentity, VERIFIABLE_IDENTITY_KINDS } from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';
import { ContactFailure } from './contact-failure.js';

/**
 * The seam every channel goes through to turn "an email arrived from
 * mona@example.com" into a contact row — M2 email, M4 widget, M6 Telegram, and
 * the admin form in this milestone.
 *
 * It is one function because DOMAIN-RULES §4.4 is one rule, and a rule
 * implemented three times is three rules:
 *
 * | The identifier is | What happens |
 * |---|---|
 * | verified, and another contact holds it | that contact is returned |
 * | verified, and nobody holds it | a new contact, with the identifier verified |
 * | unverified, and another contact holds it | **a new contact**, plus a duplicate suggestion |
 * | unverified, and nobody holds it | a new contact, with the identifier unverified |
 *
 * The third row is the one that matters. "An identifier someone types is a
 * hint, not proof" (DOMAIN-RULES §4): matching on it would let anybody who
 * knows an address walk into that person's history by typing it into a pre-chat
 * form. So the hint becomes a suggestion an agent judges, and M1-13 is what
 * acts on it.
 *
 * A phone number is never verified in v1 — Helpdock sends no SMS, so nothing
 * can prove one — and asking for `verified: true` on one is a programming error
 * rather than a request that is refused, because no caller has the standing to
 * claim it.
 */

export interface IdentityClaim {
  readonly kind: ContactIdentityKind;
  /** As it arrived. Normalised here, once, before anything is looked up. */
  readonly value: string;
  readonly verified: boolean;
  /** What established it: `email.inbound`, `widget.form`, `agent`, `import`. */
  readonly source: string;
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
   * Null in exactly one case: the value was unverified and another contact
   * already holds it, so the unique index keeps it off this one and
   * `duplicateOf` says who has it.
   */
  readonly identity: ContactIdentityRow | null;
  /** False when an existing contact was matched on a verified identifier. */
  readonly created: boolean;
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
 * Records "these two might be the same person", once per pair. A second form
 * submission from the same typed address is not a second opinion, so the insert
 * is a no-op when the pair is already there — including when an agent has
 * dismissed it, which is an answer and not an invitation to ask again.
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
    readonly reason: ContactIdentityKind;
  },
): Promise<void> => {
  if (contactId === otherContactId) {
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
  assertVerifiable(claim.kind, claim.verified);

  const value = requireNormalised(claim.kind, claim.value, options.defaultCallingCode);
  const existing = await findByIdentity(tx, brandId, claim.kind, value);

  if (existing !== undefined && claim.verified) {
    return {
      contact: await contactById(tx, brandId, existing.contactId),
      identity: existing.verified ? existing : await markVerified(tx, existing.id, claim.source),
      created: false,
      duplicateOf: null,
    };
  }

  const contact = await insertContact(tx, {
    brandId,
    name:
      options.name?.trim() === undefined || options.name.trim() === ''
        ? value
        : options.name.trim(),
    accountId: options.accountId ?? null,
  });

  if (existing !== undefined) {
    await suggestDuplicate(tx, {
      brandId,
      contactId: contact.id,
      otherContactId: existing.contactId,
      reason: claim.kind,
    });

    return { contact, identity: null, created: true, duplicateOf: existing.contactId };
  }

  const identity = await insertIdentity(tx, {
    brandId,
    contactId: contact.id,
    kind: claim.kind,
    value,
    verified: claim.verified,
    source: claim.source,
  });

  return { contact, identity, created: true, duplicateOf: null };
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
 * An identifier that was unverified on this contact and has now been proven —
 * an address somebody typed, that an email later arrived from.
 */
const markVerified = async (
  tx: DbTransaction,
  identityId: string,
  source: string,
): Promise<ContactIdentityRow> => {
  const updated = await tx
    .update(contactIdentities)
    .set({ verified: true, verifiedAt: new Date(), source })
    .where(eq(contactIdentities.id, identityId))
    .returning();

  const identity = updated[0];
  /* c8 ignore next 3 -- the row was read in this same transaction. */
  if (identity === undefined) {
    throw new Error('The contact identity vanished mid-transaction');
  }

  return identity;
};
