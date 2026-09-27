import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, type DbTransaction, type NewMailbox } from '@helpdock/db';
import { enqueueOutbox } from '@helpdock/jobs';
import type {
  ImapTestRequest,
  ImapTestResult,
  InboundParseSecret,
  InboundParseSettings,
  Mailbox,
  MailboxCreateRequest,
  MailboxList,
  MailboxUpdateRequest,
} from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import type { TicketingContext } from '../ticketing/ticketing-context.js';
import { ChannelsFailure } from './channels-failure.js';
import { toInboundParseSettings, toMailbox } from './mailbox-view.js';
import type { MailboxesRepository } from './mailboxes.repository.js';
import { isUniqueViolation } from './pg-errors.js';

/**
 * Mailboxes and the inbound-parse secret (M2-02, M2-03, M2-08): the Channels ›
 * Mailboxes tab.
 *
 * The rules this module keeps:
 *
 * - **A secret goes in and never comes out.** The IMAP password and the
 *   inbound-parse secret are encrypted under `APP_MASTER_KEY` on the way in; a
 *   read says whether one is set. The inbound-parse secret is returned exactly
 *   once, by {@link replaceSecret}, because the provider has to be told it.
 * - **A change to a mailbox is also a change to its poller.** `mailbox.changed`
 *   is written to the outbox in the same transaction, and the worker's handler
 *   re-reads the row and schedules, reschedules or removes the `email.poll`
 *   job; nothing here talks to a queue (DOMAIN-RULES §6).
 * - **Every change is audited**, with what changed and never with a secret.
 */

export const MAILBOX_CHANGED_EVENT = 'mailbox.changed';

export type ChannelsAuditAction =
  | 'mailbox.created'
  | 'mailbox.updated'
  | 'mailbox.deleted'
  | 'inbound_parse.secret_replaced';

/** "Test IMAP" as a dependency, so the service is tested without a server. */
export interface ImapTester {
  test(settings: {
    readonly host: string;
    readonly port: number;
    readonly security: 'tls' | 'starttls';
    readonly username: string;
    readonly password: string;
    readonly folder: string;
  }): Promise<ImapTestResult>;
}

export class MailboxesService {
  readonly #repository: MailboxesRepository;
  readonly #keyring: Keyring;
  readonly #imap: ImapTester;
  readonly #now: () => Date;

  constructor(options: {
    readonly repository: MailboxesRepository;
    readonly keyring: Keyring;
    readonly imap: ImapTester;
    readonly now?: () => Date;
  }) {
    this.#repository = options.repository;
    this.#keyring = options.keyring;
    this.#imap = options.imap;
    this.#now = options.now ?? (() => new Date());
  }

  async list(tx: DbTransaction): Promise<MailboxList> {
    const now = this.#now();
    return { mailboxes: (await this.#repository.list(tx)).map((row) => toMailbox(row, now)) };
  }

  async get(tx: DbTransaction, id: string): Promise<Mailbox> {
    return toMailbox(await this.#require(tx, id), this.#now());
  }

  async create(context: TicketingContext, request: MailboxCreateRequest): Promise<Mailbox> {
    const { tx, brandId, actor } = context;
    await this.#requireDepartment(tx, request.departmentId);

    const now = this.#now();
    const row = await this.#repository.insert(tx, {
      brandId,
      ...this.#common(request),
      ...(request.method === 'imap'
        ? {
            ...imapColumns(request.imap),
            imapPassword: encryptSecret(request.imap.password, this.#keyring),
            imapPasswordUpdatedAt: now,
            imapPasswordUpdatedBy: actor.userId,
          }
        : {}),
    });
    if (row === undefined) {
      throw new ChannelsFailure('address-taken');
    }

    await this.#changed(context, 'mailbox.created', row.id, { method: row.method });

    return this.get(tx, row.id);
  }

  async update(
    context: TicketingContext,
    id: string,
    request: MailboxUpdateRequest,
  ): Promise<Mailbox> {
    const { tx, actor } = context;
    const { mailbox: current } = await this.#require(tx, id);
    await this.#requireDepartment(tx, request.departmentId);

    const values: Partial<NewMailbox> = { ...this.#common(request) };
    if (request.method === 'imap') {
      const password = request.imap.password;
      if (password === undefined && current.imapPassword === null) {
        throw new ChannelsFailure('password-required');
      }
      Object.assign(values, imapColumns(request.imap));
      if (password !== undefined) {
        Object.assign(values, {
          imapPassword: encryptSecret(password, this.#keyring),
          imapPasswordUpdatedAt: this.#now(),
          imapPasswordUpdatedBy: actor.userId,
        });
      }
      // A cursor belongs to one folder on one server. Pointing the mailbox
      // somewhere else starts the new place from its unseen messages.
      if (
        current.imapHost !== request.imap.host ||
        current.imapUsername !== request.imap.username ||
        current.imapFolder !== request.imap.folder
      ) {
        Object.assign(values, { imapUidValidity: null, imapLastUid: null });
      }
      // A failure recorded against the old settings is not true of the new ones.
      Object.assign(values, { lastError: null, lastErrorKind: null, lastErrorAt: null });
    } else {
      Object.assign(values, {
        imapHost: null,
        imapPort: null,
        imapSecurity: null,
        imapUsername: null,
        imapPassword: null,
        imapPasswordUpdatedAt: null,
        imapPasswordUpdatedBy: null,
        imapUidValidity: null,
        imapLastUid: null,
      });
    }

    let updated: Awaited<ReturnType<MailboxesRepository['update']>>;
    try {
      updated = await this.#repository.update(tx, id, values);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ChannelsFailure('address-taken');
      }
      throw error;
    }
    /* c8 ignore next 3 -- the row was read in this transaction a statement ago. */
    if (updated === undefined) {
      throw new NotFoundException('No such mailbox');
    }

    await this.#changed(context, 'mailbox.updated', id, {
      method: request.method,
      passwordReplaced: request.method === 'imap' && request.imap.password !== undefined,
    });

    return this.get(tx, id);
  }

  async remove(context: TicketingContext, id: string): Promise<void> {
    const removed = await this.#repository.delete(context.tx, id);
    if (removed === undefined) {
      throw new NotFoundException('No such mailbox');
    }

    await this.#changed(context, 'mailbox.deleted', id, { address: removed.address });
  }

  /**
   * "Test IMAP": the values on screen, with the stored password when none was
   * typed. Nothing is written, not even the mailbox's health, because the
   * values tested may not be the ones saved.
   */
  async testImap(tx: DbTransaction, request: ImapTestRequest): Promise<ImapTestResult> {
    let password = request.password;
    if (password === undefined && request.mailboxId !== undefined) {
      const { mailbox } = await this.#require(tx, request.mailboxId);
      password =
        mailbox.imapPassword === null
          ? undefined
          : decryptSecret(mailbox.imapPassword, this.#keyring);
    }
    if (password === undefined) {
      throw new ChannelsFailure('password-required');
    }

    return this.#imap.test({
      host: request.host,
      port: request.port,
      security: request.security,
      username: request.username,
      password,
      folder: request.folder,
    });
  }

  async parseSettings(tx: DbTransaction, brandId: string): Promise<InboundParseSettings> {
    return toInboundParseSettings(await this.#repository.parseSettings(tx, brandId));
  }

  /** "Replace": a new secret, shown this once. The old one stops working with this commit. */
  async replaceSecret(context: TicketingContext): Promise<InboundParseSecret> {
    const secret = randomBytes(32).toString('base64url');
    await this.#repository.upsertParseSettings(context.tx, context.brandId, {
      secret: encryptSecret(secret, this.#keyring),
      secretUpdatedAt: this.#now(),
      secretUpdatedBy: context.actor.userId,
    });
    await this.#audit(context, 'inbound_parse.secret_replaced', context.brandId, {});

    return { secret };
  }

  // ------------------------------------------------------------------

  #common(request: MailboxCreateRequest | MailboxUpdateRequest) {
    return {
      address: request.address,
      displayName: request.displayName,
      departmentId: request.departmentId,
      method: request.method,
      remoteImages: request.remoteImages,
      authFailureIsSpam: request.authFailureIsSpam,
      automatedAllowlist: [...new Set(request.automatedAllowlist)],
    };
  }

  async #require(tx: DbTransaction, id: string) {
    const found = await this.#repository.find(tx, id);
    if (found === undefined) {
      throw new NotFoundException('No such mailbox');
    }

    return found;
  }

  async #requireDepartment(tx: DbTransaction, departmentId: string): Promise<void> {
    if (!(await this.#repository.departmentExists(tx, departmentId))) {
      throw new ChannelsFailure('department-not-found');
    }
  }

  async #changed(
    context: TicketingContext,
    action: ChannelsAuditAction,
    mailboxId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.#audit(context, action, mailboxId, meta);
    await enqueueOutbox(context.tx, {
      brandId: context.brandId,
      event: MAILBOX_CHANGED_EVENT,
      payload: { mailboxId },
    });
  }

  async #audit(
    { tx, brandId, actor }: TicketingContext,
    action: ChannelsAuditAction,
    targetId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId: actor.userId,
      action,
      targetType: action.startsWith('mailbox') ? 'mailbox' : 'brand',
      targetId,
      meta,
    });
  }
}

type ImapSettingsInput = Extract<MailboxUpdateRequest, { method: 'imap' }>['imap'];

const imapColumns = (imap: ImapSettingsInput) => ({
  imapHost: imap.host,
  imapPort: imap.port,
  imapSecurity: imap.security,
  imapUsername: imap.username,
  imapFolder: imap.folder,
  pollIntervalSeconds: imap.pollIntervalSeconds,
});
