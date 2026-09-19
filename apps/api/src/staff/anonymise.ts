import { createHash } from 'node:crypto';

/**
 * What is left of an account after an install admin deletes it.
 *
 * DOMAIN-RULES §12: "Only after deactivation; personal data replaced, content
 * kept as 'Former staff'". The row stays because things point at it — audit
 * rows name the actor, and from M1 a ticket names who replied — and a deleted
 * row would turn those into dangling ids nobody can explain. What goes is
 * everything that identifies a person: the name, the address, the password, the
 * authenticator and its recovery codes.
 *
 * The name is stored as the literal phrase rather than as a translation key.
 * It is a value in a column, the way a brand's name is, and every reader of
 * `users.name` — the staff list, an audit export, a later ticket header — would
 * otherwise have to know about one magic string. The screens that *do* know an
 * account was deleted say so in the reader's own language beside it.
 */

/** The phrase DOMAIN-RULES §12 names. */
export const FORMER_STAFF_NAME = 'Former staff';

/**
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so a placeholder can
 * never become a real address somebody receives mail at.
 */
const PLACEHOLDER_DOMAIN = 'deleted.invalid';

/** Half a SHA-256 is 128 bits: far more than enough for a per-install unique index. */
const DIGEST_LENGTH = 32;

/**
 * A placeholder address for a deleted account.
 *
 * It has to be **unique**, because `users` has a unique index on
 * `lower(email)` and a constant would make the second deletion fail. It has to
 * be **opaque**, because the point of the deletion is that the old address is
 * gone. And it is derived from the user id rather than from the old address, so
 * nobody holding the placeholder can confirm a guess about who it used to be by
 * hashing an address of their own.
 */
export const anonymisedEmail = (userId: string): string => {
  const digest = createHash('sha256').update(userId, 'utf8').digest('hex');

  return `former-staff+${digest.slice(0, DIGEST_LENGTH)}@${PLACEHOLDER_DOMAIN}`;
};
