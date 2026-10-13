import {
  hubChallenge,
  type MetaRoute,
  matchHubSignature,
  metaEnvelopeSchema,
  routeEnvelope,
} from '@helpdock/channels';
import type { Db } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ZodError } from 'zod';
import { isBrandGone } from '../brands/brand-availability.js';
import { failureFields } from '../channels/pg-errors.js';
import { createIpRateLimiter, type IpRateLimiter } from '../routes/ip-rate-limit.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaAppService } from './meta-app.service.js';
import type {
  MetaEventOutcome,
  MetaInboundLog,
  MetaInboundService,
} from './meta-inbound.service.js';

/**
 * `GET|POST /api/meta/webhook` (M10-02, ADR 0025, 4 and 6). One URL for the
 * install's one Meta app, for all three platforms.
 *
 * **`GET`** is Meta's handshake when the callback URL is saved in its
 * dashboard: the challenge is echoed for the install's verify token, compared
 * in constant time, and for nothing else.
 *
 * **`POST`**, in this order:
 *
 * 1. The address's budget and the signature over the raw bytes, both checked by
 *    the route's own body parser (`meta-webhook-body.ts`) before the JSON is
 *    parsed, so a body that is unsigned costs the read and nothing more
 *    ({@link MetaWebhookService.admit} and {@link MetaWebhookService.authenticate}).
 *    The signature is made with the app secret or, when set, the Instagram app
 *    secret; a bad or missing one is 401 and nothing is read further or filed.
 *    An install with no secret configured verifies nothing.
 * 2. The envelope, `{ object, entry[] }`; a body that is not one is 400. The
 *    Instagram app secret vouches for `object: instagram` only, so it cannot
 *    forge a WhatsApp or Messenger delivery: that is 401 as well.
 * 3. Each account in it, found across every brand by `(platform, external id)`
 *    (`routeEnvelope` has already cut the events by account). An unknown
 *    account is counted and passed over; one whose brand is being deleted is
 *    too (DOMAIN-RULES §11).
 * 4. Each remaining account's events filed in one transaction of its brand
 *    ({@link MetaInboundService}). An account that throws is logged and the
 *    others carry on.
 *
 * **What the response says.** Everything after a valid signature is 200,
 * because Meta treats anything else as the webhook being down: WhatsApp retries
 * for seven days, Messenger and Instagram unsubscribe the app after an hour.
 * That includes a brand in its deletion grace: the URL is the install's, not
 * the brand's, so a 410 could only make Meta redeliver the brand's events, or
 * drop every brand's. The one exception, a batch a retry can only help, is
 * decided by {@link metaWebhookVerdict}.
 */

/** What became of one account's part of a batch. */
export type MetaRouteReport =
  | {
      readonly status: 'filed';
      readonly platform: MetaPlatform;
      readonly accountId: string;
      readonly brandId: string;
      readonly events: readonly MetaEventOutcome[];
    }
  | { readonly status: 'unknown-account'; readonly platform: MetaPlatform }
  | {
      readonly status: 'brand-gone';
      readonly platform: MetaPlatform;
      readonly accountId: string;
      readonly brandId: string;
    }
  | {
      readonly status: 'failed';
      readonly platform: MetaPlatform;
      readonly accountId: string;
      readonly brandId: string;
    };

export type MetaWebhookVerdict = 'ok' | 'failed';

/**
 * The status a batch is answered with, from what became of its accounts.
 *
 * - **`failed`** (500, so Meta redelivers) only when nothing in the batch was
 *   filed and an account threw. Redelivery is safe, the dedupe key sees to it;
 *   but a batch in which something was filed is answered 200, because an
 *   account that always throws would otherwise keep a whole batch, and every
 *   brand in it, in Meta's retry loop.
 * - Otherwise **`ok`**: filed, duplicate, unknown and empty batches alike, and
 *   a brand in its deletion grace (ADR 0025 (4): the answer is for the whole
 *   batch and the install's one URL, so a 410 for one brand could only have
 *   Meta redeliver its events, or unsubscribe the app for every brand).
 */
export const metaWebhookVerdict = (reports: readonly MetaRouteReport[]): MetaWebhookVerdict => {
  const nothingFiled = !reports.some((report) => report.status === 'filed');
  if (nothingFiled && reports.some((report) => report.status === 'failed')) {
    return 'failed';
  }
  return 'ok';
};

export interface MetaWebhookResult {
  readonly verdict: MetaWebhookVerdict;
  /** One report per account in the batch, in the order Meta sent them. */
  readonly routes: readonly MetaRouteReport[];
  /** Fields of the envelope that name no account, counted and passed over. */
  readonly unrouted: number;
}

/** The two things the webhook needs of the install's Meta app. */
export type MetaAppSecrets = Pick<MetaAppService, 'signingSecrets' | 'currentVerifyToken'>;

/**
 * Which secret signed a delivery: the app's, which vouches for any platform's
 * envelope, or the Instagram app's, which vouches for Instagram's alone.
 */
export type MetaSigner = 'app' | 'instagram';

export interface MetaWebhookServiceOptions {
  readonly db: Db;
  readonly repository: Pick<MetaRepository, 'locate'>;
  readonly inbound: Pick<MetaInboundService, 'receive'>;
  readonly app: MetaAppSecrets;
  readonly log: MetaInboundLog;
  readonly now?: () => number;
}

const MINUTE_MS = 60_000;

/** True at most once a minute, for a line worth saying however fast strangers knock. */
const onceAMinute = (now: () => number): (() => boolean) => {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < MINUTE_MS) {
      return false;
    }
    last = at;
    return true;
  };
};

export class MetaWebhookService {
  readonly #options: MetaWebhookServiceOptions;
  readonly #sayNotConfigured: () => boolean;
  readonly #sayRefused: () => boolean;
  /**
   * Generous: one delivery is up to 1000 WhatsApp events and Meta posts bursts.
   * It bounds a stranger hammering the route without a secret, not Meta doing
   * its job.
   */
  readonly #limiter: IpRateLimiter;

  constructor(options: MetaWebhookServiceOptions) {
    this.#options = options;
    this.#sayNotConfigured = onceAMinute(options.now ?? Date.now);
    this.#sayRefused = onceAMinute(options.now ?? Date.now);
    this.#limiter = createIpRateLimiter({
      bucket: 'meta-webhook',
      limit: 3_000,
      windowMs: MINUTE_MS,
      maxTrackedIps: 4096,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Whether this address is within its budget; the route answers 429 when it is not. */
  admit(ip: string): boolean {
    return this.#limiter.allow(ip);
  }

  /** The handshake. Returns the challenge to echo; throws 403 for any other token. */
  async verify(query: Readonly<Record<string, unknown>>): Promise<string> {
    const challenge = hubChallenge(query, await this.#options.app.currentVerifyToken());
    if (challenge === null) {
      throw new ForbiddenException('The verify token is missing or wrong');
    }
    return challenge;
  }

  /**
   * Which secret made the signature of these exact bytes, or undefined when
   * none did. One refusal for every way to fail, so a stranger cannot tell an
   * install with no Meta app from one with a different secret; the log says
   * which, once a minute.
   */
  async authenticate(raw: Buffer, signature: string | undefined): Promise<MetaSigner | undefined> {
    const { appSecret, instagramAppSecret } = await this.#options.app.signingSecrets();
    const signedWith = matchHubSignature(raw, signature, [appSecret, instagramAppSecret]);
    if (signedWith !== undefined) {
      // One value for both settings is the app's own secret.
      return signedWith === appSecret ? 'app' : 'instagram';
    }

    if (appSecret === '' && instagramAppSecret === '') {
      if (this.#sayNotConfigured()) {
        this.#options.log.warn({}, 'meta webhook refused: no Meta app secret is set');
      }
    } else if (this.#sayRefused()) {
      this.#options.log.warn({}, 'meta webhook refused: bad or missing signature');
    }
    return undefined;
  }

  /**
   * Files a delivery the route's parser has already authenticated: `signer` is
   * what {@link authenticate} answered, and undefined (no signature was
   * checked, as for a request with no JSON body) is refused like a wrong one.
   */
  async receive(body: unknown, signer: MetaSigner | undefined): Promise<MetaWebhookResult> {
    if (signer === undefined) {
      throw new UnauthorizedException('The Meta signature is missing or wrong');
    }

    let routing: ReturnType<typeof routeEnvelope>;
    try {
      const envelope = metaEnvelopeSchema.parse(body);
      // The Instagram app secret is for Instagram's envelopes: whoever holds it
      // and nothing else must not be able to forge a WhatsApp or Page delivery.
      if (signer === 'instagram' && envelope.object !== 'instagram') {
        if (this.#sayRefused()) {
          this.#options.log.warn(
            { object: envelope.object },
            'meta webhook refused: signed with the Instagram app secret for another platform',
          );
        }
        throw new UnauthorizedException('The Meta signature is missing or wrong');
      }
      routing = routeEnvelope(envelope);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException('The body is not a Meta webhook');
      }
      throw error;
    }

    const routes: MetaRouteReport[] = [];
    for (const route of routing.routes) {
      routes.push(await this.#file(route));
    }

    const result: MetaWebhookResult = {
      verdict: metaWebhookVerdict(routes),
      routes,
      unrouted: routing.unrouted.length,
    };
    this.#options.log.info(
      {
        verdict: result.verdict,
        routes: routes.map(({ status }) => status),
        unrouted: result.unrouted,
      },
      'meta webhook handled',
    );
    return result;
  }

  async #file(route: MetaRoute): Promise<MetaRouteReport> {
    const { platform, externalId } = route;
    const locator = await this.#options.repository.locate(this.#options.db, platform, externalId);
    if (locator === undefined) {
      return { status: 'unknown-account', platform };
    }
    const { id: accountId, brandId } = locator;
    if (await isBrandGone(this.#options.db, brandId)) {
      return { status: 'brand-gone', platform, accountId, brandId };
    }

    try {
      const filed = await this.#options.inbound.receive(locator, route);
      return { status: 'filed', platform, accountId, brandId, events: filed.events };
    } catch (error) {
      // Not `err: error`: a failed query's message and params quote the
      // customer's words, a name or a number, and the log never carries those.
      this.#options.log.error(
        { accountId, brandId, platform, ...failureFields(error) },
        'meta webhook entry failed',
      );
      return { status: 'failed', platform, accountId, brandId };
    }
  }
}
