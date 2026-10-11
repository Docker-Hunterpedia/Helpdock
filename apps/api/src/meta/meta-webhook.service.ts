import {
  hubChallenge,
  type MetaRoute,
  metaEnvelopeSchema,
  routeEnvelope,
  verifyHubSignature,
} from '@helpdock/channels';
import type { Db } from '@helpdock/db';
import type { MetaPlatform } from '@helpdock/schemas';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ZodError } from 'zod';
import { isBrandGone } from '../brands/brand-availability.js';
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
 * 1. The signature over the raw bytes against the app secret and, when set, the
 *    Instagram app secret. A bad or missing one is 401 and nothing is read
 *    further or filed. An install with no secret configured verifies nothing.
 * 2. The envelope, `{ object, entry[] }`; a body that is not one is 400.
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
export type MetaAppSecrets = Pick<MetaAppService, 'secrets' | 'currentVerifyToken'>;

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

  constructor(options: MetaWebhookServiceOptions) {
    this.#options = options;
    this.#sayNotConfigured = onceAMinute(options.now ?? Date.now);
    this.#sayRefused = onceAMinute(options.now ?? Date.now);
  }

  /** The handshake. Returns the challenge to echo; throws 403 for any other token. */
  async verify(query: Readonly<Record<string, unknown>>): Promise<string> {
    const challenge = hubChallenge(query, await this.#options.app.currentVerifyToken());
    if (challenge === null) {
      throw new ForbiddenException('The verify token is missing or wrong');
    }
    return challenge;
  }

  async receive(
    raw: Buffer | undefined,
    signature: string | undefined,
    body: unknown,
  ): Promise<MetaWebhookResult> {
    await this.#verifySignature(raw, signature);

    let routing: ReturnType<typeof routeEnvelope>;
    try {
      routing = routeEnvelope(metaEnvelopeSchema.parse(body));
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

  /**
   * One refusal for every way to fail, so a stranger cannot tell an install
   * with no Meta app from one with a different secret.
   */
  async #verifySignature(raw: Buffer | undefined, signature: string | undefined): Promise<void> {
    const secrets = await this.#options.app.secrets();
    if (raw !== undefined && verifyHubSignature(raw, signature, secrets)) {
      return;
    }

    if (secrets.length === 0) {
      if (this.#sayNotConfigured()) {
        this.#options.log.warn({}, 'meta webhook refused: no Meta app secret is set');
      }
    } else if (this.#sayRefused()) {
      this.#options.log.warn({}, 'meta webhook refused: bad or missing signature');
    }
    throw new UnauthorizedException('The Meta signature is missing or wrong');
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
      this.#options.log.error(
        { accountId, brandId, platform, err: error },
        'meta webhook entry failed',
      );
      return { status: 'failed', platform, accountId, brandId };
    }
  }
}
