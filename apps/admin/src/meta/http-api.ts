import {
  type MetaAccount,
  type MetaAccountCreateRequest,
  type MetaAccountList,
  type MetaAccountStatusResponse,
  type MetaAccountUpdateRequest,
  type MetaApp,
  type MetaSubscribeResult,
  type MetaTestResult,
  type MetaTicketContextResponse,
  type MetaTokenTestRequest,
  type MetaVerifyTokenReveal,
  metaAccountListSchema,
  metaAccountSchema,
  metaAccountStatusResponseSchema,
  metaAppSchema,
  metaSubscribeResultSchema,
  metaTestResultSchema,
  metaTicketContextResponseSchema,
  metaVerifyTokenRevealSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { MetaApi } from './api.js';

/**
 * The real Meta service. It shares the app's {@link HttpTransport}, so the
 * access token and its refresh are the ones every other screen uses, and parses
 * every answer through the schema the api declared it with.
 */
export class HttpMetaApi implements MetaApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async app(): Promise<MetaApp> {
    return metaAppSchema.parse(await this.#transport.request('GET', '/meta/app'));
  }

  async rotateVerifyToken(): Promise<MetaVerifyTokenReveal> {
    return metaVerifyTokenRevealSchema.parse(
      await this.#transport.request('POST', '/meta/app/verify-token'),
    );
  }

  async accounts(brandId: string): Promise<MetaAccountList> {
    return metaAccountListSchema.parse(
      await this.#transport.request('GET', this.#accounts(brandId)),
    );
  }

  async account(brandId: string, accountId: string): Promise<MetaAccount> {
    return metaAccountSchema.parse(
      await this.#transport.request('GET', this.#account(brandId, accountId)),
    );
  }

  async createAccount(brandId: string, request: MetaAccountCreateRequest): Promise<MetaAccount> {
    return metaAccountSchema.parse(
      await this.#transport.request('POST', this.#accounts(brandId), request),
    );
  }

  async updateAccount(
    brandId: string,
    accountId: string,
    request: MetaAccountUpdateRequest,
  ): Promise<MetaAccount> {
    return metaAccountSchema.parse(
      await this.#transport.request('PUT', this.#account(brandId, accountId), request),
    );
  }

  async deleteAccount(brandId: string, accountId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#account(brandId, accountId));
  }

  async testToken(brandId: string, request: MetaTokenTestRequest): Promise<MetaTestResult> {
    return metaTestResultSchema.parse(
      await this.#transport.request('POST', `${this.#accounts(brandId)}/test`, request),
    );
  }

  async testAccount(brandId: string, accountId: string): Promise<MetaTestResult> {
    return metaTestResultSchema.parse(
      await this.#transport.request('POST', `${this.#account(brandId, accountId)}/test`),
    );
  }

  async subscribe(brandId: string, accountId: string): Promise<MetaSubscribeResult> {
    return metaSubscribeResultSchema.parse(
      await this.#transport.request('POST', `${this.#account(brandId, accountId)}/subscribe`),
    );
  }

  async status(brandId: string, accountId: string): Promise<MetaAccountStatusResponse> {
    return metaAccountStatusResponseSchema.parse(
      await this.#transport.request('GET', `${this.#account(brandId, accountId)}/status`),
    );
  }

  async ticketContext(brandId: string, ticketId: string): Promise<MetaTicketContextResponse> {
    return metaTicketContextResponseSchema.parse(
      await this.#transport.request('GET', `${this.#ticket(brandId, ticketId)}/meta`),
    );
  }

  async retryDelivery(brandId: string, ticketId: string, deliveryId: string): Promise<void> {
    await this.#transport.request(
      'POST',
      `${this.#ticket(brandId, ticketId)}/meta/deliveries/${encodeURIComponent(deliveryId)}/retry`,
    );
  }

  #ticket(brandId: string, ticketId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/tickets/${encodeURIComponent(ticketId)}`;
  }

  #accounts(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/meta/accounts`;
  }

  #account(brandId: string, accountId: string): string {
    return `${this.#accounts(brandId)}/${encodeURIComponent(accountId)}`;
  }
}
