import type {
  ContentPolicy,
  ImapTestRequest,
  ImapTestResult,
  InboundParseSecret,
  InboundParseSettings,
  Mailbox,
  MailboxCreateRequest,
  MailboxList,
  MailboxUpdateRequest,
  WidgetAccessUpdate,
  WidgetAppearance,
  WidgetConversationSettings,
  WidgetSettings,
  WidgetSignedIdentity,
  WidgetSigningSecret,
} from '@helpdock/schemas';
import {
  imapTestResultSchema,
  inboundParseSecretSchema,
  inboundParseSettingsSchema,
  mailboxListSchema,
  mailboxSchema,
  widgetSettingsSchema,
  widgetSigningSecretSchema,
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

  async widgetSettings(brandId: string): Promise<WidgetSettings> {
    return widgetSettingsSchema.parse(
      await this.#transport.request('GET', `${this.#widget(brandId)}/settings`),
    );
  }

  saveWidgetAppearance(brandId: string, request: WidgetAppearance): Promise<WidgetSettings> {
    return this.#putWidget(brandId, 'appearance', request);
  }

  saveWidgetConversation(
    brandId: string,
    request: WidgetConversationSettings,
  ): Promise<WidgetSettings> {
    return this.#putWidget(brandId, 'conversation', request);
  }

  saveWidgetContentPolicy(brandId: string, request: ContentPolicy): Promise<WidgetSettings> {
    return this.#putWidget(brandId, 'content-policy', request);
  }

  saveWidgetAccess(brandId: string, request: WidgetAccessUpdate): Promise<WidgetSettings> {
    return this.#putWidget(brandId, 'access', request);
  }

  saveWidgetSignedIdentity(
    brandId: string,
    request: WidgetSignedIdentity,
  ): Promise<WidgetSettings> {
    return this.#putWidget(brandId, 'signed-identity', request);
  }

  async replaceWidgetSigningSecret(brandId: string): Promise<WidgetSigningSecret> {
    return widgetSigningSecretSchema.parse(
      await this.#transport.request('POST', `${this.#widget(brandId)}/signing-secret`),
    );
  }

  async #putWidget(brandId: string, card: string, request: unknown): Promise<WidgetSettings> {
    return widgetSettingsSchema.parse(
      await this.#transport.request('PUT', `${this.#widget(brandId)}/${card}`, request),
    );
  }

  #widget(brandId: string): string {
    return `${this.#brand(brandId)}/widget`;
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
