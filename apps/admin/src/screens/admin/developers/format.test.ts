import type { WebhookDelivery } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import {
  deliveryFailed,
  deliveryOutcome,
  durationText,
  headerName,
  nextRetryAt,
  prettyBody,
  relativeTime,
  requestText,
  retryDelayMs,
  successRate,
} from './format.js';

const AT = '2026-10-05T14:08:00.000Z';

const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: '0192d4e0-2b3c-7d4e-8f50-000000000001',
  webhookId: '0192d4e0-2b3c-7d4e-8f50-000000000002',
  eventId: '0192d4e0-2b3c-7d4e-8f50-000000000003',
  event: 'ticket.replied',
  status: 'pending',
  attempts: 3,
  responseStatus: 500,
  responseExcerpt: 'nope',
  durationMs: 2100,
  error: 'The endpoint answered 500',
  replayOf: null,
  createdAt: AT,
  lastAttemptAt: AT,
  deliveredAt: null,
  ...overrides,
});

describe('deliveryOutcome', () => {
  it.each([
    [{ status: 'succeeded', responseStatus: 200 }, 'delivered'],
    [{ status: 'skipped' }, 'skipped'],
    [{ attempts: 0, responseStatus: null }, 'queued'],
    [{}, 'http'],
    [{ responseStatus: null, error: 'timeout: no answer within 15000 ms' }, 'timeout'],
    [{ responseStatus: null, error: 'destination-blocked: 127.0.0.1 is loopback' }, 'refused'],
    [{ responseStatus: null, error: 'port-not-allowed: port 1 is not allowed' }, 'refused'],
    [
      {
        responseStatus: null,
        error: 'The endpoint answered with a redirect; redirects are not followed',
      },
      'redirect',
    ],
    [{ responseStatus: null, error: 'network-error: ECONNRESET' }, 'noAnswer'],
  ] as const)('%o is %s', (overrides, outcome) => {
    expect(deliveryOutcome(delivery(overrides))).toBe(outcome);
  });
});

describe('deliveryFailed', () => {
  it('counts a retrying, a failed and a skipped delivery, never a queued or delivered one', () => {
    expect(deliveryFailed(delivery())).toBe(true);
    expect(deliveryFailed(delivery({ status: 'failed' }))).toBe(true);
    expect(deliveryFailed(delivery({ status: 'skipped' }))).toBe(true);
    expect(deliveryFailed(delivery({ attempts: 0 }))).toBe(false);
    expect(deliveryFailed(delivery({ status: 'succeeded' }))).toBe(false);
  });
});

describe('the retry schedule', () => {
  it('waits 30 s before the second attempt and doubles each time after', () => {
    expect([2, 3, 4, 8].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 1_920_000]);
  });

  it('puts the next attempt one wait after the last, and none once it is settled', () => {
    expect(nextRetryAt(delivery())).toBe('2026-10-05T14:10:00.000Z');
    expect(nextRetryAt(delivery({ attempts: 8 }))).toBeNull();
    expect(nextRetryAt(delivery({ status: 'failed' }))).toBeNull();
    expect(nextRetryAt(delivery({ attempts: 0, lastAttemptAt: null }))).toBeNull();
  });
});

describe('numbers and times', () => {
  it('writes durations in ms below a second and in seconds above', () => {
    expect(durationText(184, 'en')).toBe('184 ms');
    expect(durationText(2100, 'en')).toBe('2.1 s');
    expect(durationText(2100, 'ar')).toBe('2.1 s');
  });

  it('gives a success rate only when something finished', () => {
    expect(successRate({ total: 1214, succeeded: 1188 }, 'en')).toBe('97.9%');
    expect(successRate({ total: 0, succeeded: 0 }, 'en')).toBeNull();
  });

  it('says how long ago, or how long until', () => {
    const now = Date.parse(AT);
    expect(relativeTime('2026-10-05T14:06:00.000Z', now, 'en')).toBe('2 minutes ago');
    expect(relativeTime('2026-10-05T14:31:00.000Z', now, 'en')).toBe('in 23 minutes');
  });
});

describe('the request as a log prints it', () => {
  it('starts with the request line and the host, and title-cases the header names', () => {
    expect(
      requestText('https://ops.acme-shop.com/hooks/helpdock?x=1', [
        { name: 'x-helpdock-signature', value: 't=1,v1=ab' },
      ]),
    ).toBe(
      'POST /hooks/helpdock?x=1 HTTP/1.1\nHost: ops.acme-shop.com\nX-Helpdock-Signature: t=1,v1=ab',
    );
    expect(headerName('content-type')).toBe('Content-Type');
  });

  it('pretty-prints a JSON body and leaves anything else as it was', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('not json')).toBe('not json');
  });
});
