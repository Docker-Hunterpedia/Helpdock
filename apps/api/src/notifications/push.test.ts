import { createECDH, randomBytes } from 'node:crypto';
import type { safeFetch } from '@helpdock/net';
import { describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { outcomeOf, PushServiceError, type PushTarget, WebPushSender } from './push.js';

const vapid = webpush.generateVAPIDKeys();

/** A subscription's keys as a browser makes them: a P-256 public key and 16 random bytes. */
const browserKeys = (): Pick<PushTarget, 'p256dh' | 'auth'> => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();

  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
};

const payload = {
  title: 'HD-1042 missed its target',
  body: 'Refund',
  url: '/tickets/1',
  tag: 'n1',
};

describe('outcomeOf', () => {
  it('reads a 2xx as sent and a 404 or 410 as a dead subscription', () => {
    expect(outcomeOf(201)).toBe('sent');
    expect(outcomeOf(404)).toBe('gone');
    expect(outcomeOf(410)).toBe('gone');
  });

  it('throws anything else, so the job retries', () => {
    expect(() => outcomeOf(429)).toThrow(PushServiceError);
    expect(() => outcomeOf(500)).toThrow(/answered 500/);
  });
});

describe('WebPushSender', () => {
  it('posts an encrypted, VAPID-signed message to the endpoint', async () => {
    const calls: Parameters<typeof safeFetch>[] = [];
    const fetch = (async (...args: Parameters<typeof safeFetch>) => {
      calls.push(args);
      return {
        status: 201,
        headers: {},
        body: Buffer.alloc(0),
        url: String(args[0]),
        redirects: [],
      };
    }) as typeof safeFetch;
    const sender = new WebPushSender({ subject: 'https://desk.example.com', fetch });

    const outcome = await sender.send(
      { endpoint: 'https://push.example.com/send/abc', ...browserKeys() },
      payload,
      vapid,
    );

    expect(outcome).toBe('sent');
    const [url, init] = calls[0] ?? [];
    expect(url).toBe('https://push.example.com/send/abc');
    expect(init?.method).toBe('POST');
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    expect(headers.authorization).toMatch(/^vapid t=/);
    expect(headers.ttl).toBe('86400');
    // Encrypted to the browser's keys: the title is nowhere in the bytes.
    expect(Buffer.from(init?.body ?? '').toString('utf8')).not.toContain('HD-1042');
  });

  it('treats a push service in the private network as a dead subscription (DOMAIN-RULES §13)', async () => {
    const sender = new WebPushSender({ subject: 'https://desk.example.com' });

    expect(
      await sender.send({ endpoint: 'https://10.0.0.5/push', ...browserKeys() }, payload, vapid),
    ).toBe('gone');
  });

  it('lets a failure that may pass rethrow, so the job retries', async () => {
    const fetch = (async () => {
      throw new Error('socket hang up');
    }) as typeof safeFetch;
    const sender = new WebPushSender({ subject: 'https://desk.example.com', fetch });

    await expect(
      sender.send({ endpoint: 'https://push.example.com/a', ...browserKeys() }, payload, vapid),
    ).rejects.toThrow('socket hang up');
  });
});
