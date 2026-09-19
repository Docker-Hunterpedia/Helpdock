/**
 * Injection tokens for the things the realtime module is handed rather than
 * builds: the session resolver the handshake reuses, the revocation check a
 * room join repeats, the Redis connection presence lives in, the gauge M0-10
 * owns and the hook M1 fills in.
 */

export const SOCKET_SESSION_RESOLVER = Symbol('helpdock.socket-session-resolver');
export const SESSION_REVOCATIONS = Symbol('helpdock.session-revocations');
export const SOCKET_CONNECTIONS_GAUGE = Symbol('helpdock.socket-connections-gauge');
export const STAFF_OFFLINE_HOOK = Symbol('helpdock.staff-offline-hook');
