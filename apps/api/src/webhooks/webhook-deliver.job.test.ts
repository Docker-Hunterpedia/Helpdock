import { createKeyring, encryptSecret } from '@helpdock/config';
import type { Db, WebhookDeliveryRow, WebhookRow } from '@helpdock/db';
import { silentLogger, webhookDeliverJob } from '@helpdock/jobs';
import { policies, SafeFetchError, type SafeFetchResponse } from '@helpdock/net';
import {
  WEBHOOK_DELIVERY_ATTEMPTS,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_TIMEOUT_MS,
} from '@helpdock/schemas';
import type { Job } from 'bullmq';
import { describe, expect, it, type Mock, vi } from 'vitest';
import {
  createWebhookDeliverProcessor,
  RESPONSE_EXCERPT_BYTES,
  responseExcerpt,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WebhookDeliveryFailedError,
  type WebhookFetch,
} from './webhook-deliver.job.js';
import { verifyWebhookSignature } from './webhook-signature.js';
import type { AttemptRecord, WebhooksRepository } from './webhooks.repository.js';

const BRAND = '0192a000-0000-7000-8000-0000000000b1';
const DELIVERY = '0192a000-0000-7000-8000-0000000000d1';
const WEBHOOK = '0192a000-0000-7000-8000-0000000000e1';
const SECRET = 'whsec_unit';
const NOW = new Date('2026-10-05T10:00:00Z');
const keyring = createKeyring({ APP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });

/** `withTenant` sets the session settings, then hands the transaction over. */
const db = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ execute: async () => [] }),
} as unknown as Db;

const webhookRow = (overrides: Partial<WebhookRow> = {}): WebhookRow => ({
  id: WEBHOOK,
  brandId: BRAND,
  url: 'https://hooks.example.com/helpdock',
  description: '',
  events: ['ticket.created'],
  secret: encryptSecret(SECRET, keyring),
  secretRotatedAt: null,
  enabled: true,
  consecutiveFailures: 0,
  disabledAt: null,
  disabledReason: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const deliveryRow = (overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow => ({
  id: DELIVERY,
  brandId: BRAND,
  webhookId: WEBHOOK,
  eventId: '0192a000-0000-7000-8000-0000000000f1',
  event: 'ticket.created',
  payload: { id: 'evt', event: 'ticket.created', data: { ticket: { id: 't' } } },
  status: 'pending',
  attempts: 0,
  responseStatus: null,
  responseExcerpt: null,
  durationMs: null,
  error: null,
  replayOf: null,
  createdAt: NOW,
  lastAttemptAt: null,
  deliveredAt: null,
  ...overrides,
});

const response = (status: number, body = 'ok'): SafeFetchResponse => ({
  status,
  headers: {},
  body: Buffer.from(body),
  url: 'https://hooks.example.com/helpdock',
  redirects: [],
});

const job = (attemptsMade = 0) =>
  ({
    name: 'webhook.deliver',
    id: `webhook.deliver.${DELIVERY}`,
    data: { brandId: BRAND, deliveryId: DELIVERY },
    attemptsMade,
    opts: { attempts: 8 },
  }) as unknown as Job;

const setup = ({
  webhook = webhookRow(),
  delivery = deliveryRow(),
  fetch = vi.fn<WebhookFetch>(async () => response(200)),
  failures = 1,
  brandGone = false,
}: {
  webhook?: WebhookRow;
  delivery?: WebhookDeliveryRow;
  fetch?: Mock<WebhookFetch>;
  failures?: number;
  brandGone?: boolean;
} = {}) => {
  const attempts: AttemptRecord[] = [];
  const repository = {
    deliveryTarget: vi.fn(async () => ({ webhook, delivery })),
    recordAttempt: vi.fn(async (_tx: unknown, _id: string, record: AttemptRecord) => {
      attempts.push(record);
    }),
    markSkipped: vi.fn(async () => undefined),
    countFailure: vi.fn(async () => failures),
    update: vi.fn(async () => webhook),
  };
  const process = createWebhookDeliverProcessor({
    db,
    log: silentLogger,
    repository: repository as unknown as WebhooksRepository,
    keyring,
    fetch,
    brandIsGone: async () => brandGone,
    now: () => NOW,
  });
  return { process, repository, attempts, fetch };
};

describe('webhook.deliver', () => {
  it('POSTs the frozen body, signed, without following redirects, and records the success', async () => {
    const { process, fetch, attempts } = setup();

    await process(job());

    const [url, init, policy] = fetch.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
      { maxRedirects: number; maxBodyBytes: number },
    ];
    expect(url).toBe('https://hooks.example.com/helpdock');
    expect(init.method).toBe('POST');
    expect(init.headers['x-helpdock-event']).toBe('ticket.created');
    expect(init.headers['x-helpdock-delivery']).toBe(DELIVERY);
    expect(JSON.parse(init.body)).toEqual(deliveryRow().payload);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        header: init.headers['x-helpdock-signature'] ?? '',
        body: init.body,
        nowSeconds: NOW.getTime() / 1000,
      }),
    ).toBe(true);
    expect(policy.maxRedirects).toBe(0);
    expect(policy.maxBodyBytes).toBe(1024 * 1024);
    expect(attempts).toEqual([
      expect.objectContaining({ status: 'succeeded', attempts: 1, responseStatus: 200 }),
    ]);
  });

  it('records a failed attempt and throws so BullMQ retries it', async () => {
    const { process, attempts, repository } = setup({
      fetch: vi.fn<WebhookFetch>(async () => response(503)),
    });

    await expect(process(job())).rejects.toBeInstanceOf(WebhookDeliveryFailedError);
    expect(attempts).toEqual([
      expect.objectContaining({ status: 'pending', attempts: 1, responseStatus: 503 }),
    ]);
    expect(repository.countFailure).not.toHaveBeenCalled();
  });

  it('calls a redirect a failure, with a sentence that says it was not followed', async () => {
    const redirect = vi.fn<WebhookFetch>(async () => {
      throw new SafeFetchError('too-many-redirects', 'more than 0 redirects');
    });
    const { process, attempts } = setup({ fetch: redirect });

    await expect(process(job())).rejects.toThrow();
    expect(attempts[0]?.error).toMatch(/redirects are not followed/);
    expect(attempts[0]?.responseStatus).toBeNull();
  });

  it('marks the last failed attempt failed, without throwing, and counts it against the endpoint', async () => {
    const { process, attempts, repository } = setup({
      fetch: vi.fn<WebhookFetch>(async () => response(500)),
    });

    await process(job(7));

    expect(attempts[0]).toMatchObject({ status: 'failed', attempts: 8 });
    expect(repository.countFailure).toHaveBeenCalledOnce();
    expect(repository.update).not.toHaveBeenCalled();
  });

  it(`switches the endpoint off after ${WEBHOOK_DISABLE_AFTER_FAILURES} failed deliveries in a row`, async () => {
    const { process, repository } = setup({
      fetch: vi.fn<WebhookFetch>(async () => response(500)),
      failures: WEBHOOK_DISABLE_AFTER_FAILURES,
    });

    await process(job(7));

    expect(repository.update).toHaveBeenCalledWith(expect.anything(), WEBHOOK, {
      enabled: false,
      disabledAt: NOW,
      disabledReason: 'failures',
    });
  });

  it('resets the run of failures on a success', async () => {
    const { process, repository } = setup({ webhook: webhookRow({ consecutiveFailures: 3 }) });

    await process(job());

    expect(repository.update).toHaveBeenCalledWith(expect.anything(), WEBHOOK, {
      consecutiveFailures: 0,
    });
  });

  it('sends nothing for a delivery that already succeeded', async () => {
    const { process, fetch } = setup({ delivery: deliveryRow({ status: 'succeeded' }) });

    await process(job());

    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips a delivery whose endpoint was switched off meanwhile', async () => {
    const { process, fetch, repository } = setup({ webhook: webhookRow({ enabled: false }) });

    await process(job());

    expect(fetch).not.toHaveBeenCalled();
    expect(repository.markSkipped).toHaveBeenCalledOnce();
  });

  it('sends nothing for a brand in its deletion grace, and marks the delivery skipped (F5, M9-01)', async () => {
    const { process, fetch, repository } = setup({ brandGone: true });

    await process(job());

    expect(fetch).not.toHaveBeenCalled();
    expect(repository.markSkipped).toHaveBeenCalledOnce();
  });

  it('refuses a malformed payload for good', async () => {
    const { process } = setup();

    await expect(process({ ...job(), data: { brandId: BRAND } } as unknown as Job)).rejects.toThrow(
      /deliveryId/,
    );
  });
});

describe('the retry schedule the Developers page explains', () => {
  it('is the one the job and the outbound policy run', () => {
    expect(webhookDeliverJob.options).toMatchObject({
      attempts: WEBHOOK_DELIVERY_ATTEMPTS,
      backoff: { type: 'exponential', delay: WEBHOOK_RETRY_BASE_MS },
    });
    expect(policies.webhook.totalTimeoutMs).toBe(WEBHOOK_TIMEOUT_MS);
  });
});

describe('responseExcerpt', () => {
  it('keeps the first 1 KB as text, without control characters', () => {
    const excerpt = responseExcerpt(Buffer.from(`ok\u0000\u0007${'x'.repeat(5_000)}`));

    expect(excerpt.startsWith('okx')).toBe(true);
    expect(excerpt.length).toBe(RESPONSE_EXCERPT_BYTES - 2);
  });
});
