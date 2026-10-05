import { timingSafeEqual } from 'node:crypto';
import {
  InboundBodyMissingError,
  type InboundEnvelope,
  type InboundPayload,
  InboundPayloadError,
  parseInboundPayload,
  RawMessageTooLargeError,
} from '@helpdock/channels';
import { decryptSecret, type Keyring } from '@helpdock/config';
import { type Db, mailboxes } from '@helpdock/db';
import type { InboundParseOutcome, InboundParseProvider } from '@helpdock/schemas';
import {
  BadRequestException,
  GoneException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { isBrandGone } from '../../brands/brand-availability.js';
import { withSystemJob } from '../../tenant/system-job.js';
import type { MailboxesRepository, MailboxLocator } from '../mailboxes.repository.js';
import type { InboundEmailService } from './inbound-email.service.js';

/**
 * `/internal/inbound-parse/*` (M2-03): Postmark, SendGrid, Mailgun, Resend and
 * the generic JSON shape, each posting one message.
 *
 * The request carries no session and names no brand, so the order is:
 *
 * 1. Parse the payload. A body that is not the provider's shape is a 400
 *    before anything is looked up.
 * 2. Find the mailbox the first recipient names, across every brand — an
 *    install-scope read of one column (`MailboxesRepository.findByAddresses`).
 * 3. Check the shared secret **of that mailbox's brand** (ARCHITECTURE §7),
 *    from the `X-Helpdock-Inbound-Secret` header or the password of HTTP Basic
 *    auth, which is what Postmark, SendGrid and Mailgun can put in a URL.
 *    No mailbox and a wrong secret are the same 401, so the endpoint does not
 *    confirm which addresses are mailboxes.
 * 4. Hand the message to {@link InboundEmailService}, and record the request
 *    on the brand's `inbound_parse_settings` row for the card's "Last request".
 *
 * A duplicate or a dropped message is still a 200: the provider's retry would
 * only be dropped again.
 */

export interface InboundParseRequest {
  readonly provider: InboundParseProvider;
  readonly payload: InboundPayload;
  readonly secretHeader: string | undefined;
  readonly authorization: string | undefined;
}

export class InboundParseService {
  readonly #db: Db;
  readonly #repository: MailboxesRepository;
  readonly #inbound: InboundEmailService;
  readonly #keyring: Keyring;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: Db;
    readonly repository: MailboxesRepository;
    readonly inbound: InboundEmailService;
    readonly keyring: Keyring;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#repository = options.repository;
    this.#inbound = options.inbound;
    this.#keyring = options.keyring;
    this.#now = options.now ?? (() => new Date());
  }

  async receive(request: InboundParseRequest): Promise<{ outcome: InboundParseOutcome }> {
    const envelope = await parse(request);
    const mailbox = await this.#repository.findByAddresses(this.#db, envelope.recipients);
    if (mailbox === undefined || mailbox.method !== 'inbound_parse') {
      throw refused();
    }

    const presented = presentedSecret(request);
    if (presented === undefined || !(await this.#secretMatches(mailbox, presented))) {
      await this.#record(mailbox, request.provider, 'refused');
      throw refused();
    }
    // M8-07: after the secret, so a stranger cannot learn which addresses
    // belong to a brand being deleted.
    if (await isBrandGone(this.#db, mailbox.brandId)) {
      throw new GoneException('This brand is no longer available');
    }

    const result = await this.#inbound.receive(
      { brandId: mailbox.brandId, mailboxId: mailbox.id },
      envelope,
    );
    await this.#record(mailbox, request.provider, result.outcome);

    return { outcome: result.outcome };
  }

  async #secretMatches(mailbox: MailboxLocator, presented: string): Promise<boolean> {
    const settings = await withSystemJob(this.#db, mailbox.brandId, 'inbound-parse', (tx) =>
      this.#repository.parseSettings(tx, mailbox.brandId),
    );
    if (settings?.secret == null) {
      return false;
    }

    const stored = Buffer.from(decryptSecret(settings.secret, this.#keyring));
    const given = Buffer.from(presented);

    return stored.length === given.length && timingSafeEqual(stored, given);
  }

  async #record(
    mailbox: MailboxLocator,
    provider: InboundParseProvider,
    outcome: InboundParseOutcome,
  ): Promise<void> {
    const now = this.#now();
    await withSystemJob(this.#db, mailbox.brandId, 'inbound-parse', async (tx) => {
      await this.#repository.upsertParseSettings(tx, mailbox.brandId, {
        lastRequestProvider: provider,
        lastRequestAt: now,
        lastRequestOutcome: outcome,
      });
      if (outcome !== 'refused') {
        await tx
          .update(mailboxes)
          .set({ inboundProvider: provider, lastSuccessAt: now, lastPolledAt: now })
          .where(eq(mailboxes.id, mailbox.id));
      }
    });
  }
}

const refused = (): UnauthorizedException =>
  new UnauthorizedException('The inbound-parse secret is missing or wrong for these recipients');

const parse = async (request: InboundParseRequest): Promise<InboundEnvelope> => {
  try {
    return await parseInboundPayload(request.provider, request.payload);
  } catch (error) {
    if (error instanceof InboundPayloadError) {
      throw new BadRequestException(error.message);
    }
    if (error instanceof InboundBodyMissingError) {
      throw new HttpException(error.message, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (error instanceof RawMessageTooLargeError) {
      throw new HttpException(error.message, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    throw error;
  }
};

/** The header, or the password half of `Authorization: Basic`. */
export const presentedSecret = (request: {
  readonly secretHeader: string | undefined;
  readonly authorization: string | undefined;
}): string | undefined => {
  const header = request.secretHeader?.trim();
  if (header !== undefined && header !== '') {
    return header;
  }

  const basic = /^Basic\s+(\S+)$/i.exec(request.authorization ?? '');
  if (basic === null) {
    return undefined;
  }
  const decoded = Buffer.from(basic[1] ?? '', 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const password = colon === -1 ? '' : decoded.slice(colon + 1);

  return password === '' ? undefined : password;
};
