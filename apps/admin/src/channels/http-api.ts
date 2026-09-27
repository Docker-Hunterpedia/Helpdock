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
import {
  imapTestResultSchema,
  inboundParseSecretSchema,
  inboundParseSettingsSchema,
  mailboxListSchema,
  mailboxSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import { blobToDataUrl, type ChannelsApi } from './api.js';

/**
 * The real Channels service. It shares the app's {@link HttpTransport}, so the
 * access token and its refresh are the same ones every other screen uses, and
 * parses every answer through the schema the api declared it with.
 */
export class HttpChannelsApi implements ChannelsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async mailboxes(brandId: string): Promise<MailboxList> {
    return mailboxListSchema.parse(await this.#transport.request('GET', this.#mailboxes(brandId)));
  }

  async mailbox(brandId: string, mailboxId: string): Promise<Mailbox> {
    return mailboxSchema.parse(
      await this.#transport.request('GET', this.#mailbox(brandId, mailboxId)),
    );
  }

  async createMailbox(brandId: string, request: MailboxCreateRequest): Promise<Mailbox> {
    return mailboxSchema.parse(
      await this.#transport.request('POST', this.#mailboxes(brandId), request),
    );
  }

  async updateMailbox(
    brandId: string,
    mailboxId: string,
    request: MailboxUpdateRequest,
  ): Promise<Mailbox> {
    return mailboxSchema.parse(
      await this.#transport.request('PUT', this.#mailbox(brandId, mailboxId), request),
    );
  }

  async deleteMailbox(brandId: string, mailboxId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#mailbox(brandId, mailboxId));
  }

  async testImap(brandId: string, request: ImapTestRequest): Promise<ImapTestResult> {
    return imapTestResultSchema.parse(
      await this.#transport.request('POST', `${this.#mailboxes(brandId)}/test-imap`, request),
    );
  }

  async inboundParse(brandId: string): Promise<InboundParseSettings> {
    return inboundParseSettingsSchema.parse(
      await this.#transport.request('GET', `${this.#brand(brandId)}/inbound-parse`),
    );
  }

  async replaceInboundSecret(brandId: string): Promise<InboundParseSecret> {
    return inboundParseSecretSchema.parse(
      await this.#transport.request('POST', `${this.#brand(brandId)}/inbound-parse/secret`),
    );
  }

  async remoteImage(
    brandId: string,
    ticketId: string,
    messageId: string,
    index: number,
  ): Promise<string> {
    const path = `${this.#brand(brandId)}/tickets/${encodeURIComponent(ticketId)}/messages/${encodeURIComponent(messageId)}/remote-images/${String(index)}`;

    return blobToDataUrl(await this.#transport.requestBlob(path));
  }

  #brand(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}`;
  }

  #mailboxes(brandId: string): string {
    return `${this.#brand(brandId)}/mailboxes`;
  }

  #mailbox(brandId: string, mailboxId: string): string {
    return `${this.#mailboxes(brandId)}/${encodeURIComponent(mailboxId)}`;
  }
}
