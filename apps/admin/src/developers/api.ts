import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyCreateRequest,
  ApiKeyList,
  Webhook,
  WebhookCreateRequest,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryList,
  WebhookOverviewList,
  WebhooksRefusal,
  WebhookUpdateRequest,
  WebhookWithSecret,
} from '@helpdock/schemas';

/**
 * Everything the Developers page needs (M8-01, M8-03): the brand's API keys
 * and its webhook endpoints with their delivery log. `MockDevelopersApi` is
 * the fixture the unit tests and the mock Playwright projects run against;
 * `HttpDevelopersApi` is the real service. The same shape as `DomainsApi`: one
 * interface, two adapters, and refusals that cross as a code the screen picks
 * a sentence for.
 */
export interface DevelopersApi {
  apiKeys(brandId: string): Promise<ApiKeyList>;
  /** The one answer that carries the key itself. */
  createApiKey(brandId: string, request: ApiKeyCreateRequest): Promise<ApiKeyCreated>;
  revokeApiKey(brandId: string, keyId: string): Promise<ApiKey>;

  webhooks(brandId: string): Promise<WebhookOverviewList>;
  /** The one answer besides a rotation that carries the signing secret. */
  createWebhook(brandId: string, request: WebhookCreateRequest): Promise<WebhookWithSecret>;
  updateWebhook(
    brandId: string,
    webhookId: string,
    request: WebhookUpdateRequest,
  ): Promise<Webhook>;
  removeWebhook(brandId: string, webhookId: string): Promise<void>;
  rotateWebhookSecret(brandId: string, webhookId: string): Promise<WebhookWithSecret>;
  /** Queues a `ping`; the answer is the delivery to watch. */
  sendTestEvent(brandId: string, webhookId: string): Promise<WebhookDelivery>;
  deliveries(brandId: string, webhookId: string, cursor?: string): Promise<WebhookDeliveryList>;
  delivery(brandId: string, webhookId: string, deliveryId: string): Promise<WebhookDeliveryDetail>;
  replayDelivery(brandId: string, webhookId: string, deliveryId: string): Promise<WebhookDelivery>;
}

export class WebhooksError extends Error {
  readonly reason: WebhooksRefusal;
  /** What the name resolved to, for `webhook-destination-blocked`. */
  readonly address: string | undefined;

  constructor(reason: WebhooksRefusal, address?: string) {
    super(`webhooks: ${reason}`);
    this.name = 'WebhooksError';
    this.reason = reason;
    this.address = address;
  }
}

export const isWebhooksError = (error: unknown): error is WebhooksError =>
  error instanceof WebhooksError;
