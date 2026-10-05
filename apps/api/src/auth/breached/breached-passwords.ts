import { AuthFailure } from '../auth-failure.js';
import list from './breached-passwords.json' with { type: 'json' };

/**
 * ASVS 2.1.7: a new password is checked against passwords already known to
 * attackers. The list ships inside the image (`NOTICE.md` says where it comes
 * from) rather than being asked of an online service, because a self-hosted
 * install may have no route out, and because sending even a hash prefix of a
 * staff password to a third party is a disclosure the operator never agreed to
 * (ADR 0021).
 *
 * Case is ignored: `Qwertyuiop123` is the same guess as `qwertyuiop123` to
 * anybody running a cracking dictionary with its usual rules.
 */

let entries: ReadonlySet<string> | null = null;

/** Built on first use: a process that never sets a password never holds the set. */
const breached = (): ReadonlySet<string> => {
  entries ??= new Set(list as readonly string[]);
  return entries;
};

export const isBreachedPassword = (password: string): boolean =>
  breached().has(password.toLowerCase());

/**
 * Refuses a password on the list, as a `password-breached` auth failure the
 * screens render beside the field. Called wherever a password is set: the
 * wizard, an invitation, a reset and a change.
 */
export const assertNotBreached = (password: string): void => {
  if (isBreachedPassword(password)) {
    throw new AuthFailure('password-breached');
  }
};
