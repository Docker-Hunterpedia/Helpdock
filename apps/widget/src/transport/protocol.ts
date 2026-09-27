/**
 * The protocol's constants, restated here so the widget imports no runtime
 * code from `@helpdock/schemas` — that package builds its Zod schemas when it
 * loads, and the widget has 40 KB (DOMAIN-RULES §14). `protocol.test.ts`
 * fails the moment one of these drifts from the schemas' own.
 */

export const API_PREFIX = '/api/widget';
export const SOCKET_PATH = '/socket.io';
export const NAMESPACE = '/widget';
export const AUTH_SCHEME = 'Visitor';

export const EVENTS = {
  join: 'conversation:join',
  leave: 'conversation:leave',
  send: 'message:send',
  typingSet: 'typing:set',
  read: 'message:read',
  message: 'message',
  receipt: 'receipt',
  typing: 'typing',
  presence: 'presence',
  queue: 'queue',
  conversation: 'conversation',
} as const;

/** §7: "not sent, retry" after this long without a `seq`. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * A UUIDv7 (RFC 9562): 48 bits of milliseconds, then random bits, with the
 * version and variant set. What `clientId` is; sortable, so the server's
 * index on it stays in insertion order.
 */
export const uuidv7 = (now: number = Date.now()): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
