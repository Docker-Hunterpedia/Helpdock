/**
 * Where an invitation accepted with a provider comes back to (M18-07). The
 * provider round trip ends on `/oauth/callback`, and when the provider account
 * is not the invited address's, the person belongs back on their invite screen
 * with the name they typed. The api never holds the invitation's token in the
 * round trip, only its hash, so this tab remembers the way back.
 *
 * Session storage: this tab only, gone when it closes. A browser that refuses
 * storage loses only the way back; the callback screen then says what happened
 * in a sentence.
 */

const KEY = 'hd.inviteReturn';

export interface InviteReturn {
  /** The invite screen's own path, `/invite/<token>`. */
  readonly path: string;
  readonly name: string;
}

export function rememberInviteReturn(value: InviteReturn): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage refused: the callback screen falls back to its sentence.
  }
}

/** Reads and forgets it, so a later unrelated callback cannot reuse it. */
export function takeInviteReturn(): InviteReturn | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isInviteReturn(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const isInviteReturn = (value: unknown): value is InviteReturn =>
  typeof value === 'object' &&
  value !== null &&
  'path' in value &&
  'name' in value &&
  typeof value.path === 'string' &&
  value.path.startsWith('/invite/') &&
  typeof value.name === 'string';
