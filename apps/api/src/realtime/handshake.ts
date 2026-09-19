import type { Principal } from '@helpdock/schemas';
import { z } from 'zod';
import { HandshakeRefusal, type StaffSocketData } from './socket.js';

/**
 * Step 2 of ARCHITECTURE §6, over a socket: "a socket authenticates on
 * handshake exactly like HTTP" (DOMAIN-RULES §1.4).
 *
 * The credential is the same ten-minute access token the admin sends on every
 * request, presented in `auth.token` rather than in a header because a browser
 * cannot set headers on a WebSocket handshake. It is verified by the same
 * resolver, which means the same signature check, the same claim schema and the
 * same Redis revocation lookup — there is no second way in.
 *
 * Every failure refuses the connection with a code. None of them leaves the
 * client waiting: Socket.IO turns a rejected middleware into `connect_error`
 * with the message and `data` attached.
 */

/** What `resolveSession` on the session resolver answers. Narrow on purpose. */
export interface SocketSession {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly familyId: string;
  /** `exp` in epoch seconds; the socket is closed when the token behind it dies. */
  readonly expiresAt: number;
}

export interface SocketSessionResolver {
  resolveSession(token: string): Promise<SocketSession | null>;
}

const handshakeAuthSchema = z.object({ token: z.string().min(1) });

/**
 * The token out of the handshake. `Bearer <token>` is accepted as well as the
 * bare token, because a client that already holds an `Authorization` value will
 * otherwise send it verbatim and get a confusing refusal.
 */
export const handshakeToken = (auth: unknown): string | null => {
  const parsed = handshakeAuthSchema.safeParse(auth);
  if (!parsed.success) {
    return null;
  }

  const value = parsed.data.token.trim();
  if (value === '' || /^bearer$/i.test(value)) {
    // A scheme with nothing after it is not a credential, and treating the word
    // "Bearer" as one would send it to the resolver to be refused for the wrong
    // reason.
    return null;
  }

  return /^bearer\s+(?<token>\S+)$/i.exec(value)?.groups?.token ?? value;
};

export interface AuthenticateHandshakeInput {
  readonly auth: unknown;
  readonly resolver: SocketSessionResolver;
}

/**
 * @throws HandshakeRefusal when there is no usable credential. The caller hands
 * it to Socket.IO's `next`, which closes the connection with it.
 */
export const authenticateHandshake = async ({
  auth,
  resolver,
}: AuthenticateHandshakeInput): Promise<StaffSocketData> => {
  const token = handshakeToken(auth);
  if (token === null) {
    throw new HandshakeRefusal(
      'unauthenticated',
      'This namespace needs auth.token on the handshake',
    );
  }

  const session = await resolver.resolveSession(token);
  if (session === null) {
    throw new HandshakeRefusal('unauthenticated', 'That token is not valid for this install');
  }

  if (session.principal.type !== 'staff') {
    // `/staff` is for staff. Visitors get `/widget` in M4, with their own
    // credential and their own rooms (ARCHITECTURE §8).
    throw new HandshakeRefusal('forbidden', 'This namespace is for staff principals');
  }

  return {
    principal: session.principal,
    sessionId: session.sessionId,
    familyId: session.familyId,
    expiresAt: session.expiresAt,
    brandIds: new Set<string>(),
  };
};
