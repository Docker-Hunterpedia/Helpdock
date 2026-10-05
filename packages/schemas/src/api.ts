import { z } from 'zod';
import { localeSchema } from './brand.js';
import { contactCreateRequestSchema, contactSearchQuerySchema } from './contact.js';
import { hcPublishedArticleSchema, hcSlugSchema } from './help-center.js';
import { HC_SEARCH_LIMIT_MAX } from './help-center-insights.js';
import {
  messageCreateRequestSchema,
  messagePageQuerySchema,
  requireUnlessTemplate,
  ticketCreateRequestSchema,
  ticketListQuerySchema,
  ticketMessageSchema,
  ticketSchema,
} from './ticket.js';

/**
 * M8: the public REST API (REQUIREMENTS §4.11), its keys, and outbound
 * webhooks (§4.12). Everything a client of `/api/v1` sends or receives is
 * declared here, which is also what the OpenAPI document is generated from.
 */

// --------------------------------------------------------------------------
// API keys (M8-01)
// --------------------------------------------------------------------------

/** Every key starts with this, so a leaked one is recognisable by secret scanners. */
export const API_KEY_PREFIX = 'hd_live_';

/** Characters of the key kept in clear for display: the prefix and four more. */
export const API_KEY_DISPLAY_LENGTH = API_KEY_PREFIX.length + 4;

/**
 * The scopes of REQUIREMENTS §4.11, plus `webhooks:manage` for the webhook
 * routes of M8-02. A scope is also the name of the permission an `/api/v1`
 * route requires, and no staff role holds one, so a key reaches the public API
 * and nothing else.
 */
export const API_SCOPES = [
  'tickets:read',
  'tickets:write',
  'contacts:read',
  'contacts:write',
  'articles:read',
  'webhooks:manage',
] as const;
export const apiScopeSchema = z.enum(API_SCOPES);
export type ApiScope = z.infer<typeof apiScopeSchema>;

export const API_KEY_RATE_LIMIT_DEFAULT = 600;
export const API_KEY_RATE_LIMIT_MAX = 10_000;

export const apiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** `hd_live_` and the next four characters: enough to tell keys apart. */
  prefix: z.string(),
  scopes: z.array(apiScopeSchema),
  rateLimitPerMinute: z.int().positive(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

/** The answer to a create: the only time the key itself is ever returned. */
export const apiKeyCreatedSchema = apiKeySchema.extend({
  key: z.string().startsWith(API_KEY_PREFIX),
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;

export const apiKeyListSchema = z.object({ keys: z.array(apiKeySchema) });
export type ApiKeyList = z.infer<typeof apiKeyListSchema>;

export const apiKeyCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(apiScopeSchema)
    .min(1)
    .max(API_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'Name each scope once'),
  rateLimitPerMinute: z.int().min(1).max(API_KEY_RATE_LIMIT_MAX).optional(),
});
export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>;

export const apiKeyParamSchema = z.object({ brandId: z.uuid(), keyId: z.uuid() });
export type ApiKeyParam = z.infer<typeof apiKeyParamSchema>;

// --------------------------------------------------------------------------
// Outbound webhooks (M8-03)
// --------------------------------------------------------------------------

/** The events of REQUIREMENTS §4.12 an endpoint may subscribe to. */
export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.replied',
  'ticket.closed',
  'contact.created',
  'csat.received',
  'article.published',
] as const;
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** The header every delivery is signed in: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-helpdock-signature';
/** Every signing secret starts with this, so a leaked one is recognisable. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

const webhookUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2_000)
  .refine((value) => {
    // A refinement runs even after the URL check failed, so this parse may not.
    const url = URL.parse(value);
    return url === null || (url.username === '' && url.password === '');
  }, 'A webhook URL may not carry credentials');

const webhookEventsSchema = z
  .array(webhookEventSchema)
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .refine((events) => new Set(events).size === events.length, 'Name each event once');

export const webhookSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  description: z.string(),
  events: z.array(webhookEventSchema),
  enabled: z.boolean(),
  /** `failures` when Helpdock switched the endpoint off after repeated failed deliveries. */
  disabledReason: z.enum(['failures']).nullable(),
  consecutiveFailures: z.int().nonnegative(),
  secretRotatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Webhook = z.infer<typeof webhookSchema>;

/** A create or a rotation: the only times the signing secret is returned. */
export const webhookWithSecretSchema = webhookSchema.extend({
  secret: z.string().startsWith(WEBHOOK_SECRET_PREFIX),
});
export type WebhookWithSecret = z.infer<typeof webhookWithSecretSchema>;

export const webhookListSchema = z.object({ webhooks: z.array(webhookSchema) });
export type WebhookList = z.infer<typeof webhookListSchema>;

export const webhookCreateRequestSchema = z.object({
  url: webhookUrlSchema,
  description: z.string().trim().max(200).optional(),
  events: webhookEventsSchema,
});
export type WebhookCreateRequest = z.infer<typeof webhookCreateRequestSchema>;

/** `enabled: true` is how an endpoint switched off after failures is put back. */
export const webhookUpdateRequestSchema = z
  .object({
    url: webhookUrlSchema.optional(),
    description: z.string().trim().max(200).optional(),
    events: webhookEventsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Change at least one field' });
export type WebhookUpdateRequest = z.infer<typeof webhookUpdateRequestSchema>;

export const webhookDeliveryStatusSchema = z.enum(['pending', 'succeeded', 'failed', 'skipped']);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;

/** One row of the delivery log. What the receiver said is kept to 1 KB (DOMAIN-RULES §13). */
export const webhookDeliverySchema = z.object({
  id: z.uuid(),
  webhookId: z.uuid(),
  eventId: z.uuid(),
  event: webhookEventSchema,
  status: webhookDeliveryStatusSchema,
  attempts: z.int().nonnegative(),
  responseStatus: z.int().nullable(),
  responseExcerpt: z.string().nullable(),
  durationMs: z.int().nonnegative().nullable(),
  error: z.string().nullable(),
  replayOf: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastAttemptAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

export const WEBHOOK_DELIVERY_PAGE_SIZE = 50;

export const webhookDeliveryListSchema = z.object({
  deliveries: z.array(webhookDeliverySchema),
  /** Opaque; pass it back as `?cursor=` for the next page. Null on the last. */
  nextCursor: z.string().nullable(),
});
export type WebhookDeliveryList = z.infer<typeof webhookDeliveryListSchema>;

export const webhookDeliveryQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(WEBHOOK_DELIVERY_PAGE_SIZE).optional(),
});
export type WebhookDeliveryQuery = z.infer<typeof webhookDeliveryQuerySchema>;

export const webhookParamSchema = z.object({ brandId: z.uuid(), webhookId: z.uuid() });
export type WebhookParam = z.infer<typeof webhookParamSchema>;
export const webhookDeliveryParamSchema = webhookParamSchema.extend({ deliveryId: z.uuid() });
export type WebhookDeliveryParam = z.infer<typeof webhookDeliveryParamSchema>;

/**
 * What every delivery's body is. `id` is the event's, the same on a retry and
 * on a replay, so a receiver dedupes on it.
 */
export const webhookEnvelopeSchema = z.object({
  id: z.uuid(),
  event: webhookEventSchema,
  createdAt: z.iso.datetime(),
  brandId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

// --------------------------------------------------------------------------
// REST v1 (M8-02)
// --------------------------------------------------------------------------

/** The header a `POST` carries to be retried safely; its answer is kept for 24 hours. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Printable ASCII without spaces');

/**
 * A ticket filed through the API. The admin's create, minus the channel, which
 * is always `api`, and the composer's `clientId`; idempotency is the
 * `Idempotency-Key` header's job here.
 */
const {
  channel: _channel,
  clientId: _clientId,
  ...ticketCreateShape
} = ticketCreateRequestSchema.shape;

export const v1TicketCreateRequestSchema = z
  .object(ticketCreateShape)
  .superRefine(requireUnlessTemplate);
export type V1TicketCreateRequest = z.infer<typeof v1TicketCreateRequestSchema>;

export const v1TicketListQuerySchema = ticketListQuerySchema;

export const v1TicketSchema = ticketSchema;

/** A ticket with the start of its thread, as a create or a read answers. */
export const v1TicketDetailSchema = z.object({
  ticket: ticketSchema,
  messages: z.array(ticketMessageSchema),
});
export type V1TicketDetail = z.infer<typeof v1TicketDetailSchema>;

/**
 * A reply or a note from an integration. Attachments, the time tracker and the
 * email sender are the admin composer's and are not part of the public API.
 */
export const v1MessageCreateRequestSchema = messageCreateRequestSchema.pick({
  kind: true,
  bodyHtml: true,
  clientId: true,
});
export type V1MessageCreateRequest = z.infer<typeof v1MessageCreateRequestSchema>;

export const v1MessagePageQuerySchema = messagePageQuerySchema;

export const v1TicketParamSchema = z.object({ ticketId: z.uuid() });
export type V1TicketParam = z.infer<typeof v1TicketParamSchema>;

/**
 * Upsert: a contact with this `externalId`, or else holding one of these
 * identifiers, is updated; otherwise one is created.
 */
export const v1ContactUpsertRequestSchema = contactCreateRequestSchema;
export type V1ContactUpsertRequest = z.infer<typeof v1ContactUpsertRequestSchema>;

export const v1ContactSearchQuerySchema = contactSearchQuerySchema.pick({
  search: true,
  cursor: true,
  limit: true,
});
export type V1ContactSearchQuery = z.infer<typeof v1ContactSearchQuerySchema>;

export const v1ContactIdentitySchema = z.object({
  kind: z.string(),
  value: z.string(),
  verified: z.boolean(),
});

export const v1ContactSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  externalId: z.string().nullable(),
  locale: localeSchema.nullable(),
  timezone: z.string().nullable(),
  identities: z.array(v1ContactIdentitySchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type V1Contact = z.infer<typeof v1ContactSchema>;

/** Which of the three an upsert did, so an integration can tell a new contact from a match. */
export const v1ContactUpsertSchema = z.object({
  contact: v1ContactSchema,
  created: z.boolean(),
});
export type V1ContactUpsert = z.infer<typeof v1ContactUpsertSchema>;

export const v1ContactListSchema = z.object({
  contacts: z.array(v1ContactSchema),
  nextCursor: z.string().nullable(),
});
export type V1ContactList = z.infer<typeof v1ContactListSchema>;

export const v1ContactParamSchema = z.object({ contactId: z.uuid() });

/** Articles are read as a visitor reads them: published and public only (DOMAIN-RULES §5). */
export const v1ArticleSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  locale: localeSchema.default('en'),
  limit: z.coerce.number().int().min(1).max(HC_SEARCH_LIMIT_MAX).default(10),
  offset: z.coerce.number().int().min(0).max(1_000).default(0),
});
export type V1ArticleSearchQuery = z.infer<typeof v1ArticleSearchQuerySchema>;

export const v1ArticleHitSchema = z.object({
  articleId: z.uuid(),
  slug: z.string(),
  locale: localeSchema,
  title: z.string(),
  snippet: z.string(),
  sectionTitle: z.string(),
});

export const v1ArticleSearchSchema = z.object({
  hits: z.array(v1ArticleHitSchema),
  total: z.int().nonnegative(),
});
export type V1ArticleSearch = z.infer<typeof v1ArticleSearchSchema>;

export const v1ArticleParamSchema = z.object({ slug: hcSlugSchema });
export const v1ArticleQuerySchema = z.object({ locale: localeSchema.default('en') });
export type V1ArticleQuery = z.infer<typeof v1ArticleQuerySchema>;

export const v1ArticleSchema = hcPublishedArticleSchema;

export const v1WebhookParamSchema = z.object({ webhookId: z.uuid() });
export type V1WebhookParam = z.infer<typeof v1WebhookParamSchema>;
export const v1WebhookDeliveryParamSchema = v1WebhookParamSchema.extend({ deliveryId: z.uuid() });
export type V1WebhookDeliveryParam = z.infer<typeof v1WebhookDeliveryParamSchema>;
