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

/**
 * Reads it and leaves it there. Safe to call while rendering: React may render
 * a screen more than once before it commits (a suspended render is thrown away
 * and started again), and a read that also forgot would hand the second render
 * nothing. {@link forgetInviteReturn} does the forgetting, once the screen is up.
 */
export function readInviteReturn(): InviteReturn | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isInviteReturn(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Forgets it, so a later unrelated callback cannot reuse it. */
export function forgetInviteReturn(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage refused: there was nothing to forget.
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
