import {
  API_SCOPES,
  type ApiScope,
  errorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  ticketListSchema,
  ticketMessagePageSchema,
  ticketMessageSchema,
  ticketUpdateRequestSchema,
  v1ArticleParamSchema,
  v1ArticleQuerySchema,
  v1ArticleSchema,
  v1ArticleSearchQuerySchema,
  v1ArticleSearchSchema,
  v1ContactListSchema,
  v1ContactParamSchema,
  v1ContactSchema,
  v1ContactSearchQuerySchema,
  v1ContactUpsertRequestSchema,
  v1ContactUpsertSchema,
  v1MessageCreateRequestSchema,
  v1MessagePageQuerySchema,
  v1TicketCreateRequestSchema,
  v1TicketDetailSchema,
  v1TicketListQuerySchema,
  v1TicketParamSchema,
  v1TicketSchema,
  v1WebhookDeliveryParamSchema,
  v1WebhookParamSchema,
  webhookCreateRequestSchema,
  webhookDeliveryListSchema,
  webhookDeliveryQuerySchema,
  webhookDeliverySchema,
  webhookListSchema,
  webhookSchema,
  webhookUpdateRequestSchema,
  webhookWithSecretSchema,
} from '@helpdock/schemas';
import { z } from 'zod';

/**
 * The OpenAPI 3.1 document of `/api/v1` (M8-02, REQUIREMENTS §4.11), generated
 * from the very Zod schemas the routes validate and serialise with. One entry
 * per route; `openapi.test.ts` fails when a route of the v1 controllers is
 * missing here, so the document cannot drift from the code.
 *
 * OpenAPI 3.1 is JSON Schema 2020-12, which is what `z.toJSONSchema` writes:
 * no translation layer and no second schema language.
 */

type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface ApiOperation {
  readonly method: HttpMethod;
  /** OpenAPI path template: `/api/v1/tickets/{ticketId}`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tag: 'Tickets' | 'Contacts' | 'Articles' | 'Webhooks';
  readonly scope: ApiScope;
  readonly params?: ObjectSchema;
  readonly query?: ObjectSchema;
  readonly body?: z.ZodType;
  /** Absent for a 204. */
  readonly response?: z.ZodType;
  readonly status: 200 | 201 | 204;
  /** Accepts `Idempotency-Key`. */
  readonly idempotent?: boolean;
}

export const API_OPERATIONS: readonly ApiOperation[] = [
  {
    method: 'get',
    path: '/api/v1/tickets',
    operationId: 'listTickets',
    summary: 'List tickets, newest activity first, a cursor page at a time',
    tag: 'Tickets',
    scope: 'tickets:read',
    query: v1TicketListQuerySchema,
    response: ticketListSchema,
    status: 200,
  },
  {
    method: 'post',
    path: '/api/v1/tickets',
    operationId: 'createTicket',
    summary: 'File a ticket with its first message, on the api channel',
    tag: 'Tickets',
    scope: 'tickets:write',
    body: v1TicketCreateRequestSchema,
    response: v1TicketDetailSchema,
    status: 201,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/api/v1/tickets/{ticketId}',
    operationId: 'getTicket',
    summary: 'Read a ticket and the start of its thread',
    tag: 'Tickets',
    scope: 'tickets:read',
    params: v1TicketParamSchema,
    response: v1TicketDetailSchema,
    status: 200,
  },
  {
    method: 'patch',
    path: '/api/v1/tickets/{ticketId}',
    operationId: 'updateTicket',
    summary:
      'Change a ticket: subject, status, priority, department, team, assignee, custom fields',
    tag: 'Tickets',
    scope: 'tickets:write',
    params: v1TicketParamSchema,
    body: ticketUpdateRequestSchema,
    response: v1TicketSchema,
    status: 200,
  },
  {
    method: 'delete',
    path: '/api/v1/tickets/{ticketId}',
    operationId: 'deleteTicket',
    summary: 'Hide a ticket from every view; retention purges it later',
    tag: 'Tickets',
    scope: 'tickets:write',
    params: v1TicketParamSchema,
    status: 204,
  },
  {
    method: 'get',
    path: '/api/v1/tickets/{ticketId}/messages',
    operationId: 'listTicketMessages',
    summary: 'Read the thread after a sequence number',
    tag: 'Tickets',
    scope: 'tickets:read',
    params: v1TicketParamSchema,
    query: v1MessagePageQuerySchema,
    response: ticketMessagePageSchema,
    status: 200,
  },
  {
    method: 'post',
    path: '/api/v1/tickets/{ticketId}/messages',
    operationId: 'addTicketMessage',
    summary: 'Add a public message or an internal note',
    tag: 'Tickets',
    scope: 'tickets:write',
    params: v1TicketParamSchema,
    body: v1MessageCreateRequestSchema,
    response: ticketMessageSchema,
    status: 201,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/api/v1/contacts',
    operationId: 'searchContacts',
    summary: 'Search contacts by name or identifier',
    tag: 'Contacts',
    scope: 'contacts:read',
    query: v1ContactSearchQuerySchema,
    response: v1ContactListSchema,
    status: 200,
  },
  {
    method: 'post',
    path: '/api/v1/contacts',
    operationId: 'upsertContact',
    summary: 'Create a contact, or update the one with this externalId or identifier',
    tag: 'Contacts',
    scope: 'contacts:write',
    body: v1ContactUpsertRequestSchema,
    response: v1ContactUpsertSchema,
    status: 200,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/api/v1/contacts/{contactId}',
    operationId: 'getContact',
    summary: 'Read a contact',
    tag: 'Contacts',
    scope: 'contacts:read',
    params: v1ContactParamSchema,
    response: v1ContactSchema,
    status: 200,
  },
  {
    method: 'get',
    path: '/api/v1/articles',
    operationId: 'searchArticles',
    summary: 'Search published, public help center articles',
    tag: 'Articles',
    scope: 'articles:read',
    query: v1ArticleSearchQuerySchema,
    response: v1ArticleSearchSchema,
    status: 200,
  },
  {
    method: 'get',
    path: '/api/v1/articles/{slug}',
    operationId: 'getArticle',
    summary: 'Read a published, public article by its slug',
    tag: 'Articles',
    scope: 'articles:read',
    params: v1ArticleParamSchema,
    query: v1ArticleQuerySchema,
    response: v1ArticleSchema,
    status: 200,
  },
  {
    method: 'get',
    path: '/api/v1/webhooks',
    operationId: 'listWebhooks',
    summary: 'List webhook endpoints',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    response: webhookListSchema,
    status: 200,
  },
  {
    method: 'post',
    path: '/api/v1/webhooks',
    operationId: 'createWebhook',
    summary: 'Add an endpoint; the signing secret is returned this once',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    body: webhookCreateRequestSchema,
    response: webhookWithSecretSchema,
    status: 201,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/api/v1/webhooks/{webhookId}',
    operationId: 'getWebhook',
    summary: 'Read an endpoint',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    params: v1WebhookParamSchema,
    response: webhookSchema,
    status: 200,
  },
  {
    method: 'patch',
    path: '/api/v1/webhooks/{webhookId}',
    operationId: 'updateWebhook',
    summary: 'Change an endpoint, or switch it back on',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    params: v1WebhookParamSchema,
    body: webhookUpdateRequestSchema,
    response: webhookSchema,
    status: 200,
  },
  {
    method: 'delete',
    path: '/api/v1/webhooks/{webhookId}',
    operationId: 'deleteWebhook',
    summary: 'Remove an endpoint and its delivery log',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    params: v1WebhookParamSchema,
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/webhooks/{webhookId}/rotate-secret',
    operationId: 'rotateWebhookSecret',
    summary: 'Replace the signing secret; the new one is returned this once',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    params: v1WebhookParamSchema,
    response: webhookWithSecretSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/webhooks/{webhookId}/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: 'Read the delivery log, newest first',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    params: v1WebhookParamSchema,
    query: webhookDeliveryQuerySchema,
    response: webhookDeliveryListSchema,
    status: 200,
  },
  {
    method: 'post',
    path: '/api/v1/webhooks/{webhookId}/deliveries/{deliveryId}/replay',
    operationId: 'replayWebhookDelivery',
    summary: 'Send a delivery again, with the same event id',
    tag: 'Webhooks',
    scope: 'webhooks:manage',
    params: v1WebhookDeliveryParamSchema,
    response: webhookDeliverySchema,
    status: 201,
  },
];

type JsonSchema = Record<string, unknown>;

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output'): JsonSchema => {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  });
  return rest;
};

const parametersOf = (schema: ObjectSchema | undefined, location: 'path' | 'query') => {
  if (schema === undefined) {
    return [];
  }
  const object = jsonSchema(schema, 'input') as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(object.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || (object.required ?? []).includes(name),
    schema: property,
  }));
};

const json = (schema: JsonSchema) => ({ 'application/json': { schema } });

const ERROR = { $ref: '#/components/schemas/Error' };

const operationObject = (operation: ApiOperation) => ({
  operationId: operation.operationId,
  summary: operation.summary,
  tags: [operation.tag],
  security: [{ apiKey: [operation.scope] }],
  'x-required-scope': operation.scope,
  parameters: [
    ...parametersOf(operation.params, 'path'),
    ...parametersOf(operation.query, 'query'),
    ...(operation.idempotent === true
      ? [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Retry safely: the first answer to this key is replayed for 24 hours.',
            schema: jsonSchema(idempotencyKeySchema, 'input'),
          },
        ]
      : []),
  ],
  ...(operation.body === undefined
    ? {}
    : { requestBody: { required: true, content: json(jsonSchema(operation.body, 'input')) } }),
  responses: {
    [String(operation.status)]:
      operation.response === undefined
        ? { description: 'Done; no body' }
        : { description: 'OK', content: json(jsonSchema(operation.response, 'output')) },
    '400': { description: 'The request did not match its schema', content: json(ERROR) },
    '401': { description: 'No API key, or a revoked one', content: json(ERROR) },
    '403': { description: `The key does not hold ${operation.scope}`, content: json(ERROR) },
    '404': { description: 'Not found in this brand', content: json(ERROR) },
    '410': { description: "The key's brand is scheduled for deletion", content: json(ERROR) },
    '429': { description: 'The key is over its per-minute rate limit', content: json(ERROR) },
  },
});

/** The whole document. Built once per process; it changes only with the code. */
export const buildOpenApiDocument = (version: string) => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of API_OPERATIONS) {
    paths[operation.path] = {
      ...(paths[operation.path] ?? {}),
      [operation.method]: operationObject(operation),
    };
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Helpdock API',
      version,
      description: `Tickets, contacts, help center articles and webhooks for one brand. Authenticate with \`Authorization: Bearer hd_live_…\`; the ${IDEMPOTENCY_KEY_HEADER} header makes a POST safe to retry.`,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    tags: [{ name: 'Tickets' }, { name: 'Contacts' }, { name: 'Articles' }, { name: 'Webhooks' }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'hd_live_ API key',
          description: `A brand's API key. Scopes: ${API_SCOPES.join(', ')}.`,
        },
      },
      schemas: { Error: jsonSchema(errorResponseSchema, 'output') },
    },
  };
};

export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
