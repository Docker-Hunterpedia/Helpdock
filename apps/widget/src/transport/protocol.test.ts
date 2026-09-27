import {
  SOCKET_IO_PATH,
  VISITOR_AUTH_SCHEME,
  WIDGET_API_PREFIX,
  WIDGET_EVENTS,
  WIDGET_NAMESPACE,
  WIDGET_SEND_TIMEOUT_MS,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_SCHEME,
  EVENTS,
  NAMESPACE,
  SEND_TIMEOUT_MS,
  SOCKET_PATH,
  uuidv7,
} from './protocol.js';

describe('the protocol constants', () => {
  it('match the schemas the api is built on', () => {
    expect({ API_PREFIX, AUTH_SCHEME, EVENTS, NAMESPACE, SEND_TIMEOUT_MS, SOCKET_PATH }).toEqual({
      API_PREFIX: WIDGET_API_PREFIX,
      AUTH_SCHEME: VISITOR_AUTH_SCHEME,
      EVENTS: WIDGET_EVENTS,
      NAMESPACE: WIDGET_NAMESPACE,
      SEND_TIMEOUT_MS: WIDGET_SEND_TIMEOUT_MS,
      SOCKET_PATH: SOCKET_IO_PATH,
    });
  });
});

describe('uuidv7', () => {
  it('is a version 7 UUID whose first 48 bits are the time', () => {
    const at = Date.UTC(2026, 8, 27, 10, 0, 0);
    const id = uuidv7(at);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at);
    expect(uuidv7(at)).not.toBe(id);
  });
});
