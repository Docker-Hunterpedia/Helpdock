import {
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeyCreateRequest,
  type ApiKeyList,
  apiKeyCreatedSchema,
  apiKeyListSchema,
  apiKeySchema,
  type Webhook,
  type WebhookCreateRequest,
  type WebhookDelivery,
  type WebhookDeliveryDetail,
  type WebhookDeliveryList,
  type WebhookOverviewList,
  type WebhookUpdateRequest,
  type WebhookWithSecret,
  webhookDeliveryDetailSchema,
  webhookDeliveryListSchema,
  webhookDeliverySchema,
  webhookOverviewListSchema,
  webhookSchema,
  webhookWithSecretSchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import type { DevelopersApi } from './api.js';

/**
 * The real Developers service. It shares the app's {@link HttpTransport}, so
 * the access token and its refresh are the ones every other screen uses, and
 * parses every answer through the schema the api declared it with.
 */
export class HttpDevelopersApi implements DevelopersApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async apiKeys(brandId: string): Promise<ApiKeyList> {
    return apiKeyListSchema.parse(await this.#transport.request('GET', this.#keys(brandId)));
  }

  async createApiKey(brandId: string, request: ApiKeyCreateRequest): Promise<ApiKeyCreated> {
    return apiKeyCreatedSchema.parse(
      await this.#transport.request('POST', this.#keys(brandId), request),
    );
  }

  async revokeApiKey(brandId: string, keyId: string): Promise<ApiKey> {
    return apiKeySchema.parse(
      await this.#transport.request(
        'DELETE',
        `${this.#keys(brandId)}/${encodeURIComponent(keyId)}`,
      ),
    );
  }

  async webhooks(brandId: string): Promise<WebhookOverviewList> {
    return webhookOverviewListSchema.parse(
      await this.#transport.request('GET', this.#webhooks(brandId)),
    );
  }

  async createWebhook(brandId: string, request: WebhookCreateRequest): Promise<WebhookWithSecret> {
    return webhookWithSecretSchema.parse(
      await this.#transport.request('POST', this.#webhooks(brandId), request),
    );
  }

  async updateWebhook(
    brandId: string,
    webhookId: string,
    request: WebhookUpdateRequest,
  ): Promise<Webhook> {
    return webhookSchema.parse(
      await this.#transport.request('PATCH', this.#webhook(brandId, webhookId), request),
    );
  }

  async removeWebhook(brandId: string, webhookId: string): Promise<void> {
    await this.#transport.request('DELETE', this.#webhook(brandId, webhookId));
  }

  async rotateWebhookSecret(brandId: string, webhookId: string): Promise<WebhookWithSecret> {
    return webhookWithSecretSchema.parse(
      await this.#transport.request('POST', `${this.#webhook(brandId, webhookId)}/rotate-secret`),
    );
  }

  async sendTestEvent(brandId: string, webhookId: string): Promise<WebhookDelivery> {
    return webhookDeliverySchema.parse(
      await this.#transport.request('POST', `${this.#webhook(brandId, webhookId)}/test`),
    );
  }

  async deliveries(
    brandId: string,
    webhookId: string,
    cursor?: string,
  ): Promise<WebhookDeliveryList> {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return webhookDeliveryListSchema.parse(
      await this.#transport.request('GET', `${this.#deliveries(brandId, webhookId)}${query}`),
    );
  }

  async delivery(
    brandId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDeliveryDetail> {
    return webhookDeliveryDetailSchema.parse(
      await this.#transport.request(
        'GET',
        `${this.#deliveries(brandId, webhookId)}/${encodeURIComponent(deliveryId)}`,
      ),
    );
  }

  async replayDelivery(
    brandId: string,
    webhookId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    return webhookDeliverySchema.parse(
      await this.#transport.request(
        'POST',
        `${this.#deliveries(brandId, webhookId)}/${encodeURIComponent(deliveryId)}/replay`,
      ),
    );
  }

  #keys(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/api-keys`;
  }

  #webhooks(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/webhooks`;
  }

  #webhook(brandId: string, webhookId: string): string {
    return `${this.#webhooks(brandId)}/${encodeURIComponent(webhookId)}`;
  }

  #deliveries(brandId: string, webhookId: string): string {
    return `${this.#webhook(brandId, webhookId)}/deliveries`;
  }
}
