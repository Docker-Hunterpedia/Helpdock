import { createHash } from 'node:crypto';
import type { ContactIdentityKind } from '@helpdock/schemas';

/**
 * What is left of a contact after a privacy request (DOMAIN-RULES §11):
 * "replaces name, emails, phone, Telegram id and visitor ids with hashes …
 * Recorded in the audit log without the erased values."
 *
 * The row survives, because tickets, messages and audit rows point at it and a
 * deleted row would turn a history into dangling ids nobody can explain. What
 * goes is everything that identifies a person.
 *
 * **Hashes, not deletions.** The identifier rows stay, with their value
 * replaced by a digest. That keeps the unique index meaningful — an erased
 * address cannot be re-attached to somebody else by accident — and keeps the
 * number of channels the person used visible in reports, which is a count and
 * not a person.
 *
 * The digest is **salted with the contact id**, so the same address erased in
 * two brands gives two different digests and nobody holding one can confirm a
 * guess by hashing an address of their own. It is deliberately not reversible
 * and not comparable: there is no "undo" for an erasure, by design.
 */

/** The phrase an erased contact is shown under, as a value rather than a key. */
export const ERASED_CONTACT_NAME = 'Erased contact';

/** Half a SHA-256 is 128 bits: far more than a per-brand unique index needs. */
const DIGEST_LENGTH = 32;

export const erasedIdentityValue = (contactId: string, kind: ContactIdentityKind): string =>
  `erased:${kind}:${createHash('sha256')
    .update(`${contactId}:${kind}`, 'utf8')
    .digest('hex')
    .slice(0, DIGEST_LENGTH)}`;

/**
 * What the audit row carries. Counts and kinds, never a value — an audit log is
 * read by more people than the table it describes, and a row that quoted the
 * address would put back exactly what the erasure took out.
 */
export interface ErasureSummary {
  readonly identityCount: number;
  readonly kinds: readonly ContactIdentityKind[];
  readonly noteCount: number;
  readonly hadAccount: boolean;
  readonly hadExternalId: boolean;
}

export const erasureSummary = (input: {
  readonly kinds: readonly ContactIdentityKind[];
  readonly noteCount: number;
  readonly hadAccount: boolean;
  readonly hadExternalId: boolean;
}): ErasureSummary => ({
  identityCount: input.kinds.length,
  kinds: [...new Set(input.kinds)].sort(),
  noteCount: input.noteCount,
  hadAccount: input.hadAccount,
  hadExternalId: input.hadExternalId,
});
