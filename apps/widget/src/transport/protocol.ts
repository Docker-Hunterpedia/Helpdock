/**
 * The protocol's constants, restated here so the widget imports no runtime
 * code from `@helpdock/schemas` — that package builds its Zod schemas when it
 * loads, and the widget has 40 KB (DOMAIN-RULES §14). Types come from there
 * with `import type`, which the build erases. `protocol.test.ts` fails the
 * moment one of these drifts from the schemas' own.
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

/** The largest catch-up page the api serves (`WIDGET_MESSAGE_PAGE_MAX`). */
export const PAGE_MAX = 200;
