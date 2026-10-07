import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { ROUTE_DECLARATION, type RouteDeclaration } from '../auth/route-declaration.js';
import { renderDocsPage } from './api-docs.controller.js';
import { API_OPERATIONS, buildOpenApiDocument } from './openapi.js';
import { V1ArticlesController } from './v1-articles.controller.js';
import { V1ContactsController } from './v1-contacts.controller.js';
import { V1TicketsController } from './v1-tickets.controller.js';
import { V1WebhooksController } from './v1-webhooks.controller.js';

const CONTROLLERS = [
  V1TicketsController,
  V1ContactsController,
  V1ArticlesController,
  V1WebhooksController,
];

/** Every route the v1 controllers declare, as `METHOD /path` with OpenAPI braces, and its scope. */
const declaredRoutes = (): Map<string, string> => {
  const routes = new Map<string, string>();
  for (const controller of CONTROLLERS) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    const prototype = controller.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      const path = Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined;
      if (name === 'constructor' || path === undefined) {
        continue;
      }
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler as object)];
      const declaration = Reflect.getMetadata(ROUTE_DECLARATION, handler as object) as
        | RouteDeclaration
        | undefined;
      const full = `/${[base, path].filter((part) => part !== '/' && part !== '').join('/')}`;
      routes.set(
        `${String(method)} ${full.replace(/:(\w+)/g, '{$1}')}`,
        declaration?.kind === 'permission' ? declaration.permission : 'none',
      );
    }
  }
  return routes;
};

describe('the OpenAPI document', () => {
  const document = buildOpenApiDocument('1.2.3');

  it('describes every /api/v1 route, with the scope the route requires, and nothing else', () => {
    const documented = new Map(
      API_OPERATIONS.map((operation) => [
        `${operation.method.toUpperCase()} ${operation.path}`,
        operation.scope,
      ]),
    );

    expect(documented).toEqual(declaredRoutes());
  });

  it('is OpenAPI 3.1 over JSON Schema 2020-12, with the bearer scheme', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(document.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(document.components.securitySchemes.apiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('generates bodies, parameters and answers from the route schemas', () => {
    const create = document.paths['/api/v1/tickets']?.post as {
      requestBody: { content: { 'application/json': { schema: { properties: object } } } };
      parameters: { name: string; in: string }[];
      responses: Record<string, unknown>;
    };

    expect(Object.keys(create.requestBody.content['application/json'].schema.properties)).toContain(
      'bodyHtml',
    );
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }),
    );
    expect(Object.keys(create.responses)).toEqual(
      expect.arrayContaining(['201', '401', '403', '429']),
    );

    const read = document.paths['/api/v1/tickets/{ticketId}']?.get as {
      parameters: { name: string; in: string; required: boolean }[];
    };
    expect(read.parameters).toContainEqual(
      expect.objectContaining({ name: 'ticketId', in: 'path', required: true }),
    );
  });
});

describe('renderDocsPage', () => {
  it('lists every operation, escaped, with a link to the JSON', () => {
    const page = renderDocsPage(buildOpenApiDocument('1.2.3'));

    expect(page).toContain('href="/api/docs/openapi.json"');
    expect(page).toContain('/api/v1/tickets/{ticketId}');
    expect(page).not.toContain('<script');
    expect(page.match(/<tr><td>/g)).toHaveLength(API_OPERATIONS.length);
  });
});
