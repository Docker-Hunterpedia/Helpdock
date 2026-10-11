import { decryptSecret, type Keyring } from '@helpdock/config';
import type { Db } from '@helpdock/db';
import { type JobLogger, parseJobPayloadOrFail, webhookDeliverJob } from '@helpdock/jobs';
import {
  policies,
  SafeFetchError,
  type SafeFetchInit,
  type SafeFetchPolicy,
  type SafeFetchResponse,
  safeFetch,
} from '@helpdock/net';
import type { Job } from 'bullmq';
import { isBrandGone } from '../brands/brand-availability.js';
import { withSystemJob } from '../tenant/system-job.js';
import { type WebhookRequest, webhookRequest } from './webhook-request.js';
import type { WebhooksRepository } from './webhooks.repository.js';

/**
 * The `webhook.deliver` consumer (M8-03): one delivery row in, one signed POST
 * out, through the SSRF-safe client of DOMAIN-RULES §13.
 *
 * - **Never followed.** Redirects are not followed (`maxRedirects: 0`): a 3xx
 *   is a failed attempt, so an endpoint cannot bounce a delivery to an address
 *   it could not have been registered at. The body is read only for the first
 *   1 KB the delivery log keeps, and never parsed or rendered.
 * - **Idempotent by delivery.** Only a `pending` delivery is sent; a success is
 *   final, so a redelivered job sends nothing (DOMAIN-RULES §6).
 * - **Not for a brand being deleted.** A delivery of a brand in its grace is
 *   marked skipped, not sent (DOMAIN-RULES §11).
 * - **Retried** by BullMQ with exponential backoff; each attempt is recorded
 *   on the row. The last failed attempt marks the delivery `failed` and adds
 *   one to the endpoint's run of failures, and at
 *   {@link WEBHOOK_DISABLE_AFTER_FAILURES} the endpoint is switched off.
 *
 * The request is made between two short transactions, never inside one: a slow
 * receiver must not hold a database connection for fifteen seconds.
 */

/** Consecutive failed deliveries after which an endpoint is switched off. */
export const WEBHOOK_DISABLE_AFTER_FAILURES = 10;

/** What the delivery log keeps of a response body (DOMAIN-RULES §13). */
export const RESPONSE_EXCERPT_BYTES = 1024;

const ERROR_MAX_LENGTH = 500;

export type WebhookFetch = (
  url: string,
  init: SafeFetchInit,
  policy: SafeFetchPolicy,
) => Promise<SafeFetchResponse>;

export interface WebhookDeliverDependencies {
  readonly db: Db;
  readonly log: JobLogger;
  readonly repository: WebhooksRepository;
  readonly keyring: Keyring;
  /** `OUTBOUND_ALLOW_CIDRS`, the lookup in tests, and the blocked-attempt log. */
  readonly policy?: SafeFetchPolicy;
  readonly fetch?: WebhookFetch;
  /** Whether the brand is `deleting` or `deleted`; a suite passes a stand-in for the read. */
  readonly brandIsGone?: (brandId: string) => Promise<boolean>;
  readonly now?: () => Date;
}

/** The first 1 KB of the body as text, with control characters dropped. */
export const responseExcerpt = (body: Buffer): string =>
  body
    .subarray(0, RESPONSE_EXCERPT_BYTES)
    .toString('utf8')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

const describeFailure = (error: unknown): string => {
  if (error instanceof SafeFetchError) {
    return error.code === 'too-many-redirects'
      ? 'The endpoint answered with a redirect; redirects are not followed'
      : `${error.code}: ${error.message}`.slice(0, ERROR_MAX_LENGTH);
  }
  return (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_LENGTH);
};

interface Outcome {
  readonly ok: boolean;
  readonly responseStatus: number | null;
  readonly responseExcerpt: string | null;
  readonly error: string | null;
  readonly durationMs: number;
}

export class WebhookDeliveryFailedError extends Error {
  constructor(deliveryId: string, reason: string) {
    super(`Webhook delivery ${deliveryId} failed: ${reason}`);
    this.name = 'WebhookDeliveryFailedError';
  }
}

export const createWebhookDeliverProcessor = ({
  db,
  log,
  repository,
  keyring,
  policy = {},
  fetch: deliver = safeFetch,
  brandIsGone = (brandId) => isBrandGone(db, brandId),
  now = () => new Date(),
}: WebhookDeliverDependencies) => {
  const post = async (url: string, { headers, body }: WebhookRequest): Promise<Outcome> => {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const response = await deliver(
        url,
        { method: 'POST', headers: { ...headers }, body },
        { ...policies.webhook, ...policy, maxRedirects: 0 },
      );
      const ok = response.status >= 200 && response.status < 300;
      return {
        ok,
        responseStatus: response.status,
        responseExcerpt: responseExcerpt(response.body),
        error: ok ? null : `The endpoint answered ${String(response.status)}`,
        durationMs: elapsed(),
      };
    } catch (error) {
      return {
        ok: false,
        responseStatus: null,
        responseExcerpt: null,
        error: describeFailure(error),
        durationMs: elapsed(),
      };
    }
  };

  return async (job: Job): Promise<void> => {
    const { brandId, deliveryId } = parseJobPayloadOrFail(webhookDeliverJob, job.data);
    const principal = `webhook.deliver:${deliveryId}`;

    const target = await withSystemJob(db, brandId, principal, (tx) =>
      repository.deliveryTarget(tx, deliveryId),
    );
    if (target === undefined || target.delivery.status !== 'pending') {
      log.info(
        { brandId, deliveryId, status: target?.delivery.status ?? null },
        'webhook.deliver skipped: nothing pending to send',
      );
      return;
    }
    const { delivery, webhook } = target;
    // A brand in its deletion grace is switched off: nothing is sent on its
    // behalf (DOMAIN-RULES §11), and a restore does not replay what it missed.
    if (await brandIsGone(brandId)) {
      await withSystemJob(db, brandId, principal, (tx) =>
        repository.markSkipped(tx, deliveryId, 'The brand is being deleted'),
      );
      return;
    }
    if (!webhook.enabled) {
      await withSystemJob(db, brandId, principal, (tx) =>
        repository.markSkipped(tx, deliveryId, 'The endpoint is switched off'),
      );
      return;
    }

    // One clock reading for the signature and for `last_attempt_at`, so the
    // delivery log can show the signature this attempt carried.
    const sentAt = now();
    const outcome = await post(
      webhook.url,
      webhookRequest(delivery, decryptSecret(webhook.secret, keyring), sentAt),
    );

    // A replay inserts a fresh row, so the row's count is this job's own; it
    // survives an attempt that died before BullMQ counted it, and BullMQ's
    // count survives an attempt that died before it could write the row. The
    // larger is the truth.
    const attempts = Math.max(delivery.attempts, job.attemptsMade) + 1;
    const last = attempts >= (job.opts.attempts ?? webhookDeliverJob.options.attempts ?? 1);
    const status = outcome.ok ? 'succeeded' : last ? 'failed' : 'pending';

    await withSystemJob(db, brandId, principal, async (tx) => {
      await repository.recordAttempt(tx, deliveryId, { ...outcome, status, attempts, at: sentAt });
      if (outcome.ok) {
        if (webhook.consecutiveFailures > 0) {
          await repository.update(tx, webhook.id, { consecutiveFailures: 0 });
        }
        return;
      }
      if (!last) {
        return;
      }
      const failures = await repository.countFailure(tx, webhook.id);
      if (failures >= WEBHOOK_DISABLE_AFTER_FAILURES) {
        await repository.update(tx, webhook.id, {
          enabled: false,
          disabledAt: now(),
          disabledReason: 'failures',
        });
        log.warn({ brandId, webhookId: webhook.id, failures }, 'webhook endpoint switched off');
      }
    });

    // The URL and the status, never the body (REQUIREMENTS §5.1).
    log.info(
      {
        brandId,
        deliveryId,
        webhookId: webhook.id,
        event: delivery.event,
        attempt: attempts,
        responseStatus: outcome.responseStatus,
        durationMs: outcome.durationMs,
        status,
      },
      'webhook delivery attempted',
    );

    if (!outcome.ok && !last) {
      throw new WebhookDeliveryFailedError(deliveryId, outcome.error ?? 'unknown');
    }
  };
};
