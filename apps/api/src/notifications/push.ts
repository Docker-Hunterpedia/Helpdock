import { policies, SafeFetchError, type SafeFetchErrorCode, safeFetch } from '@helpdock/net';
import webpush from 'web-push';

/**
 * Web push, as ADR 0002 decides it: RFC 8030 delivery, RFC 8292 VAPID, and
 * `web-push` for the parts that are cryptography — the payload encrypted to the
 * subscription's keys and the signed VAPID header.
 *
 * The request itself goes through `safeFetch` rather than `web-push`'s own
 * `https.request`. The endpoint is a URL a browser handed the api, which makes
 * it user-supplied, and DOMAIN-RULES §13 sends every such fetch through the
 * SSRF-safe client: a staff member who registers `https://10.0.0.5/` as their
 * "push service" gets a refused job, not a POST into the private network.
 */

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** What the service worker receives. Kept small: push services cap payloads at 4 KB. */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** Where a click on it goes, relative to the admin app. */
  readonly url: string;
  /** Replaces an earlier push with the same tag rather than stacking. */
  readonly tag: string;
}

/**
 * `sent`: the push service took it. `gone`: the subscription is dead (`404`,
 * `410`) and its row should be deleted. Anything else throws, and the job
 * retries.
 */
export type PushOutcome = 'sent' | 'gone';

export interface PushSender {
  send(target: PushTarget, payload: PushPayload, vapid: VapidKeys): Promise<PushOutcome>;
}

export class PushServiceError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`The push service answered ${String(status)}`);
    this.name = 'PushServiceError';
    this.status = status;
  }
}

/**
 * Refusals that will be refused again. `dns-failure` is not one: a push
 * service's name that did not resolve once may resolve on the next attempt.
 */
const REFUSED: ReadonlySet<SafeFetchErrorCode> = new Set([
  'invalid-url',
  'scheme-not-allowed',
  'credentials-in-url',
  'port-not-allowed',
  'destination-blocked',
  'redirect-blocked',
  'too-many-redirects',
]);

/** A day: a notification older than that is no longer worth waking a phone for. */
export const PUSH_TTL_SECONDS = 86_400;

export class WebPushSender implements PushSender {
  readonly #subject: string;
  readonly #allowCidrs: readonly string[];
  readonly #fetch: typeof safeFetch;

  /**
   * `subject` is the VAPID contact, a `mailto:` or `https:` URL; `APP_URL` is
   * what an install has. `allowCidrs` is `OUTBOUND_ALLOW_CIDRS`.
   */
  constructor({
    subject,
    allowCidrs = [],
    fetch = safeFetch,
  }: {
    readonly subject: string;
    readonly allowCidrs?: readonly string[];
    /** The tests hand in a push service; production is the SSRF-safe client. */
    readonly fetch?: typeof safeFetch;
  }) {
    this.#subject = subject;
    this.#allowCidrs = allowCidrs;
    this.#fetch = fetch;
  }

  async send(target: PushTarget, payload: PushPayload, vapid: VapidKeys): Promise<PushOutcome> {
    const request = webpush.generateRequestDetails(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: {
          subject: this.#subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        TTL: PUSH_TTL_SECONDS,
      },
    );

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = String(value);
    }

    try {
      const response = await this.#fetch(
        request.endpoint,
        { method: 'POST', headers, ...(request.body === null ? {} : { body: request.body }) },
        { ...policies.webhook, allowCidrs: this.#allowCidrs },
      );

      return outcomeOf(response.status);
    } catch (error) {
      // A destination the policy refuses will be refused on every attempt;
      // the subscription is as good as dead, and deleting it stops the retries.
      if (error instanceof SafeFetchError && REFUSED.has(error.code)) {
        return 'gone';
      }
      throw error;
    }
  }
}

export const outcomeOf = (status: number): PushOutcome => {
  if (status >= 200 && status < 300) {
    return 'sent';
  }
  if (status === 404 || status === 410) {
    return 'gone';
  }
  throw new PushServiceError(status);
};
