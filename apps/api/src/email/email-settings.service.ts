import { classifySmtpError, describeSmtpError } from '@helpdock/channels';
import { encryptSecret, type Keyring } from '@helpdock/config';
import { auditLog, type DbTransaction } from '@helpdock/db';
import {
  type AutoReplies,
  EMAIL_SEND_ATTEMPTS,
  type EmailOutgoingSettings,
  type EmailSenders,
  type EmailSignature,
  type FailedSendList,
  type OutgoingSmtpTestResult,
  type OutgoingSmtpUpdate,
  SMTP_RESPONSE_MAX_LENGTH,
  type TicketEmailContext,
} from '@helpdock/schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { escapeHtml } from '../auth/email-templates.js';
import type { EmailRepository } from './email.repository.js';
import { outgoingTestCopy } from './email-copy.js';
import type { OutboundEmailService } from './outbound-email.service.js';
import {
  autoRepliesFrom,
  resolveSender,
  selectedSenderKey,
  senderOptions,
  sendersFrom,
  smtpFrom,
  storedTemplatesFrom,
} from './outgoing-settings.js';
import { signatureFor } from './render-delivery.js';
import {
  brandSmtpServer,
  type InstallSmtp,
  type SmtpServer,
  type SmtpTransportFactory,
} from './transport.js';

/**
 * The http half of M2-05 and M2-06: Channels › Outgoing email (Admin only, by
 * `brand:manage` on the routes), a person's own signature, and what the ticket
 * view's composer and thread need to send and to show a failed send.
 *
 * Every save writes an `audit_log` row naming what changed and never a
 * password: "Password changed" is what an auditor needs, and a secret in a log
 * is a secret leaked (AGENTS.md).
 */

export interface EmailSettingsContext {
  readonly tx: DbTransaction;
  readonly brandId: string;
  readonly actorId: string;
}

export interface EmailSettingsDependencies {
  readonly repository: EmailRepository;
  readonly outbound: OutboundEmailService;
  readonly keyring: Keyring;
  readonly installSmtp: InstallSmtp;
  readonly transports: SmtpTransportFactory;
  readonly now?: () => Date;
}

const emptyToNull = (value: string): string | null => (value.trim() === '' ? null : value);

export class EmailSettingsService {
  readonly #repository: EmailRepository;
  readonly #outbound: OutboundEmailService;
  readonly #keyring: Keyring;
  readonly #installSmtp: InstallSmtp;
  readonly #transports: SmtpTransportFactory;
  readonly #now: () => Date;

  constructor({
    repository,
    outbound,
    keyring,
    installSmtp,
    transports,
    now = () => new Date(),
  }: EmailSettingsDependencies) {
    this.#repository = repository;
    this.#outbound = outbound;
    this.#keyring = keyring;
    this.#installSmtp = installSmtp;
    this.#transports = transports;
    this.#now = now;
  }

  // --------------------------------------------------------- Outgoing email

  async outgoing(tx: DbTransaction, brandId: string): Promise<EmailOutgoingSettings> {
    const row = await this.#repository.settings(tx, brandId);
    const updatedBy =
      row?.smtpUpdatedBy == null ? null : await this.#repository.userName(tx, row.smtpUpdatedBy);

    return {
      smtp: smtpFrom(row, updatedBy),
      installSmtpConfigured: (await this.#installSmtp.read()) !== undefined,
      senders: sendersFrom(row, await this.#repository.departmentIds(tx)),
      autoReplies: autoRepliesFrom(row),
    };
  }

  async saveSmtp(
    { tx, brandId, actorId }: EmailSettingsContext,
    body: OutgoingSmtpUpdate,
  ): Promise<EmailOutgoingSettings> {
    const passwordChanged = body.password !== undefined;
    await this.#repository.saveSettings(tx, brandId, {
      smtpHost: body.host,
      smtpPort: body.port,
      smtpTls: body.tls,
      smtpUser: body.user,
      ...(passwordChanged
        ? {
            smtpPassword:
              body.password === '' ? null : encryptSecret(body.password ?? '', this.#keyring),
          }
        : {}),
      smtpUpdatedAt: this.#now(),
      smtpUpdatedBy: actorId,
    });
    await this.#audit(tx, brandId, actorId, 'email.smtp.updated', {
      host: body.host,
      port: body.port,
      tls: body.tls,
      user: body.user,
      passwordChanged,
    });

    return this.outgoing(tx, brandId);
  }

  /**
   * "Test SMTP": one message to the person who pressed it, through the server
   * on screen. It runs in the request, like the wizard's, because the answer
   * is drawn inline — and it is no domain change: nothing is stored.
   */
  async testSmtp(
    { tx, brandId, actorId }: EmailSettingsContext,
    body: OutgoingSmtpUpdate,
  ): Promise<OutgoingSmtpTestResult> {
    const user = await this.#repository.userAddress(tx, actorId);
    const brand = await this.#repository.brand(tx, brandId);
    if (user === undefined || brand === undefined) {
      throw new NotFoundException();
    }
    const { email: recipient, locale } = user;

    const row = await this.#repository.settings(tx, brandId);
    const stored = brandSmtpServer(row, this.#keyring);
    const server: SmtpServer = {
      host: body.host,
      port: body.port,
      tls: body.tls,
      user: body.user,
      password: body.password ?? stored?.password ?? '',
    };
    const install = await this.#installSmtp.read();
    const sender = resolveSender(row, { departmentId: '', key: 'default' }, install?.from);
    const from = sender?.from ?? { address: recipient, name: brand.name };
    const copy = outgoingTestCopy(locale, { brandName: brand.name, host: body.host });

    const transport = this.#transports(server, from);
    const started = Date.now();
    try {
      await transport.send({
        to: { address: recipient },
        subject: copy.subject,
        text: `${copy.heading}\n\n${copy.body}`,
        html: `<p><strong>${escapeHtml(copy.heading)}</strong></p><p>${escapeHtml(copy.body)}</p>`,
        locale,
      });
      return { delivered: true, recipient, durationMs: Date.now() - started };
    } catch (error) {
      return {
        delivered: false,
        recipient,
        durationMs: Date.now() - started,
        error: classifySmtpError(error),
        detail: describeSmtpError(error, SMTP_RESPONSE_MAX_LENGTH),
      };
    } finally {
      transport.close();
    }
  }

  async saveSenders(
    { tx, brandId, actorId }: EmailSettingsContext,
    body: EmailSenders,
  ): Promise<EmailOutgoingSettings> {
    const known = await this.#repository.departmentIds(tx);
    if (body.departments.some((row) => !known.has(row.departmentId))) {
      throw new BadRequestException('A sender names a department this brand does not have.');
    }

    await this.#repository.saveSettings(tx, brandId, {
      defaultFromName: body.defaultFrom?.name ?? null,
      defaultFromAddress: body.defaultFrom?.address ?? null,
      departmentSenders: body.departments.map((row) => ({
        departmentId: row.departmentId,
        fromName: row.from.name,
        fromAddress: row.from.address,
        replyTo: row.replyTo,
      })),
    });
    await this.#audit(tx, brandId, actorId, 'email.senders.updated', {
      defaultFrom: body.defaultFrom?.address ?? null,
      departments: body.departments.map((row) => row.departmentId),
    });

    return this.outgoing(tx, brandId);
  }

  async saveAutoReplies(
    { tx, brandId, actorId }: EmailSettingsContext,
    body: AutoReplies,
  ): Promise<EmailOutgoingSettings> {
    await this.#repository.saveSettings(tx, brandId, {
      acknowledgmentEnabled: body.acknowledgment.enabled,
      outOfHoursEnabled: body.outOfHours.enabled,
      autoReplyHourlyCap: body.perSenderHourlyCap,
      autoReplyTemplates: storedTemplatesFrom(body),
    });
    await this.#audit(tx, brandId, actorId, 'email.auto_replies.updated', {
      acknowledgment: body.acknowledgment.enabled,
      outOfHours: body.outOfHours.enabled,
      perSenderHourlyCap: body.perSenderHourlyCap,
    });

    return this.outgoing(tx, brandId);
  }

  // ------------------------------------------------------------ Failed sends

  async failedSends(tx: DbTransaction): Promise<FailedSendList> {
    const rows = await this.#repository.failedSends(tx);

    return {
      items: rows.map((row) => ({
        ...row,
        maxAttempts: EMAIL_SEND_ATTEMPTS,
        failedAt: row.failedAt.toISOString(),
      })),
    };
  }

  async retry({ tx, brandId, actorId }: EmailSettingsContext, deliveryId: string): Promise<void> {
    if ((await this.#outbound.retry(tx, brandId, [deliveryId])) === 0) {
      throw new NotFoundException();
    }
    await this.#audit(tx, brandId, actorId, 'email.send.retried', { deliveryIds: [deliveryId] });
  }

  async retryAll({ tx, brandId, actorId }: EmailSettingsContext): Promise<number> {
    const ids = await this.#repository.failedIds(tx);
    const retried = await this.#outbound.retry(tx, brandId, ids);
    if (retried > 0) {
      await this.#audit(tx, brandId, actorId, 'email.send.retried', { deliveryIds: ids });
    }
    return retried;
  }

  async discard({ tx, brandId, actorId }: EmailSettingsContext, deliveryId: string): Promise<void> {
    if (!(await this.#repository.discard(tx, deliveryId))) {
      throw new NotFoundException();
    }
    await this.#audit(tx, brandId, actorId, 'email.send.discarded', { deliveryId });
  }

  // -------------------------------------------------------------- Signature

  async signature(tx: DbTransaction, userId: string): Promise<EmailSignature> {
    const row = await this.#repository.signature(tx, userId);
    return { en: row?.en ?? '', ar: row?.ar ?? '' };
  }

  async saveSignature(
    tx: DbTransaction,
    userId: string,
    body: EmailSignature,
  ): Promise<EmailSignature> {
    await this.#repository.saveSignature(tx, userId, {
      en: emptyToNull(body.en),
      ar: emptyToNull(body.ar),
    });
    return this.signature(tx, userId);
  }

  // ------------------------------------------------------------- Ticket view

  /**
   * The composer's email mode and the thread's delivery marks. A ticket the
   * reader cannot see is a 404, from the policy, like every ticket read.
   */
  async ticketContext(
    tx: DbTransaction,
    brandId: string,
    ticketId: string,
    userId: string,
  ): Promise<TicketEmailContext> {
    const addressing = await this.#repository.replyAddressing(tx, ticketId);
    if (addressing === undefined) {
      throw new NotFoundException();
    }

    const row = await this.#repository.settings(tx, brandId);
    const install = await this.#installSmtp.read();
    const senders = senderOptions(row, install?.from);
    const own = await this.#repository.signature(tx, userId);
    const name = (await this.#repository.userName(tx, userId)) ?? '';
    const deliveries = await this.#repository.deliveriesForTicket(tx, ticketId);

    return {
      senders,
      selectedKey: selectedSenderKey(addressing.departmentId, senders),
      to: addressing.contact,
      signature: signatureFor(
        { name, signatureEn: own?.en ?? null, signatureAr: own?.ar ?? null },
        addressing.locale,
      ),
      locale: addressing.locale,
      deliveries: deliveries.flatMap((delivery) =>
        delivery.ticketMessageId === null
          ? []
          : [
              {
                messageId: delivery.ticketMessageId,
                status: delivery.status,
                attempts: delivery.attempts,
                lastError: delivery.lastError,
              },
            ],
      ),
    };
  }

  /** The thread's "Retry" on a reply that was not delivered. */
  async retryMessage(
    context: EmailSettingsContext,
    ticketId: string,
    messageId: string,
  ): Promise<void> {
    const delivery = await this.#repository.deliveryForMessage(context.tx, ticketId, messageId);
    if (delivery === undefined) {
      throw new NotFoundException();
    }
    await this.retry(context, delivery.id);
  }

  async #audit(
    tx: DbTransaction,
    brandId: string,
    actorId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.insert(auditLog).values({
      brandId,
      actorType: 'staff',
      actorId,
      action,
      targetType: 'brand',
      targetId: brandId,
      meta,
    });
  }
}
