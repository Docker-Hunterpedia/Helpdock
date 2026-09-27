import {
  SOCKET_IO_PATH,
  VISITOR_AUTH_SCHEME,
  WIDGET_API_PREFIX,
  WIDGET_EVENTS,
  WIDGET_MESSAGE_PAGE_MAX,
  WIDGET_NAMESPACE,
} from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { API_PREFIX, AUTH_SCHEME, EVENTS, NAMESPACE, PAGE_MAX, SOCKET_PATH } from './protocol.js';

describe('the protocol constants', () => {
  it('match the schemas the api is built on', () => {
    expect({ API_PREFIX, AUTH_SCHEME, EVENTS, NAMESPACE, PAGE_MAX, SOCKET_PATH }).toEqual({
      API_PREFIX: WIDGET_API_PREFIX,
      AUTH_SCHEME: VISITOR_AUTH_SCHEME,
      EVENTS: WIDGET_EVENTS,
      NAMESPACE: WIDGET_NAMESPACE,
      PAGE_MAX: WIDGET_MESSAGE_PAGE_MAX,
      SOCKET_PATH: SOCKET_IO_PATH,
    });
  });
});
