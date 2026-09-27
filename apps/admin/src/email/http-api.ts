import type {
  AutoReplies,
  EmailOutgoingSettings,
  EmailSenders,
  EmailSignature,
  FailedSendList,
  OutgoingSmtpTestResult,
  OutgoingSmtpUpdate,
  TicketEmailContext,
} from '@helpdock/schemas';
import {
  emailOutgoingSettingsSchema,
  emailSignatureSchema,
  failedSendListSchema,
  failedSendRetryResultSchema,
  outgoingSmtpTestResultSchema,
  ticketEmailContextSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { EmailApi } from './api.js';

/**
 * The real outbound email service. It shares the app's {@link HttpTransport},
 * and parses every response through the schema the api declared it with.
 */
export class HttpEmailApi implements EmailApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async outgoing(brandId: string): Promise<EmailOutgoingSettings> {
    return emailOutgoingSettingsSchema.parse(
      await this.#transport.request('GET', `${this.#email(brandId)}/outgoing`),
    );
  }

  async saveSmtp(brandId: string, request: OutgoingSmtpUpdate): Promise<EmailOutgoingSettings> {
    return emailOutgoingSettingsSchema.parse(
      await this.#transport.request('PUT', `${this.#email(brandId)}/outgoing/smtp`, request),
    );
  }

  async testSmtp(brandId: string, request: OutgoingSmtpUpdate): Promise<OutgoingSmtpTestResult> {
    return outgoingSmtpTestResultSchema.parse(
      await this.#transport.request('POST', `${this.#email(brandId)}/outgoing/smtp/test`, request),
    );
  }

  async saveSenders(brandId: string, request: EmailSenders): Promise<EmailOutgoingSettings> {
    return emailOutgoingSettingsSchema.parse(
      await this.#transport.request('PUT', `${this.#email(brandId)}/outgoing/senders`, request),
    );
  }

  async saveAutoReplies(brandId: string, request: AutoReplies): Promise<EmailOutgoingSettings> {
    return emailOutgoingSettingsSchema.parse(
      await this.#transport.request(
        'PUT',
        `${this.#email(brandId)}/outgoing/auto-replies`,
        request,
      ),
    );
  }

  async failedSends(brandId: string): Promise<FailedSendList> {
    return failedSendListSchema.parse(
      await this.#transport.request('GET', `${this.#email(brandId)}/failed-sends`),
    );
  }

  async retryFailedSend(brandId: string, deliveryId: string): Promise<void> {
    await this.#transport.request('POST', `${this.#failedSend(brandId, deliveryId)}/retry`);
  }

  async retryAllFailedSends(brandId: string): Promise<number> {
    return failedSendRetryResultSchema.parse(
      await this.#transport.request('POST', `${this.#email(brandId)}/failed-sends/retry-all`),
    ).retried;
  }

  async discardFailedSend(brandId: string, deliveryId: string): Promise<void> {
    await this.#transport.request('POST', `${this.#failedSend(brandId, deliveryId)}/discard`);
  }

  async signature(): Promise<EmailSignature> {
    return emailSignatureSchema.parse(await this.#transport.request('GET', '/me/signature'));
  }

  async saveSignature(request: EmailSignature): Promise<EmailSignature> {
    return emailSignatureSchema.parse(
      await this.#transport.request('PUT', '/me/signature', request),
    );
  }

  async ticketEmail(brandId: string, ticketId: string): Promise<TicketEmailContext> {
    return ticketEmailContextSchema.parse(
      await this.#transport.request('GET', this.#ticketEmail(brandId, ticketId)),
    );
  }

  async retryMessage(brandId: string, ticketId: string, messageId: string): Promise<void> {
    await this.#transport.request(
      'POST',
      `${this.#ticketEmail(brandId, ticketId)}/messages/${encodeURIComponent(messageId)}/retry`,
    );
  }

  #email(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/email`;
  }

  #failedSend(brandId: string, deliveryId: string): string {
    return `${this.#email(brandId)}/failed-sends/${encodeURIComponent(deliveryId)}`;
  }

  #ticketEmail(brandId: string, ticketId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/tickets/${encodeURIComponent(ticketId)}/email`;
  }
}
