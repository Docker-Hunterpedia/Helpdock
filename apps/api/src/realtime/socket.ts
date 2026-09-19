import type { Principal, SocketError, SocketErrorCode } from '@helpdock/schemas';
import type { Socket } from 'socket.io';

/** `/staff` refuses anything else at the handshake, so the socket carries no wider type. */
export type StaffPrincipal = Extract<Principal, { type: 'staff' }>;

/**
 * What a `/staff` socket carries once its handshake has been accepted.
 *
 * The principal is the same object the HTTP guards see, which is the point: a
 * socket "authenticates on handshake exactly like HTTP" and every room join
 * "runs the same permission check as the corresponding REST read"
 * (DOMAIN-RULES §1.4). The session id is kept so a join can re-ask whether that
 * session has been revoked since; the family id is kept so a log line can say
 * which browser a socket belongs to.
 */
export interface StaffSocketData {
  readonly principal: StaffPrincipal;
  /** `sid` from the access token's claims. */
  readonly sessionId: string;
  /** `fam` from the access token's claims. */
  readonly familyId: string;
  /**
   * `exp` from the claims, in epoch seconds. A socket's authority is the token
   * it was opened with, and DOMAIN-RULES §1.6 caps that at ten minutes, so the
   * socket is closed when the token behind it expires. The client reconnects
   * with a fresh one; nothing a person can see changes.
   */
  readonly expiresAt: number;
  /** Brand ids whose `brand:` room this socket has joined, for presence bookkeeping. */
  readonly brandIds: Set<string>;
}

export type StaffSocket = Socket & { data: StaffSocketData };

/** The id presence is keyed by: a staff principal is a user. */
export const userIdOf = (data: StaffSocketData): string => data.principal.id;

/**
 * A handshake refusal. Socket.IO passes `message` to the client's
 * `connect_error` and serialises `data` alongside it, so the client gets a code
 * it can translate rather than a sentence it has to match on. The connection is
 * always refused with one of these and never left to hang.
 */
export class HandshakeRefusal extends Error {
  readonly data: SocketError;

  constructor(code: SocketErrorCode, message: string) {
    super(message);
    this.name = 'HandshakeRefusal';
    this.data = { code, message };
  }
}
