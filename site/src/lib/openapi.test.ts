import { describe, expect, it } from 'vitest';
import { constraints, describeType, endpoints, fieldsOf, type OpenApiDocument } from './openapi.ts';

describe('describeType', () => {
  it.each([
    [{ type: 'string', format: 'uuid' }, 'string (uuid)'],
    [{ enum: ['open', 'closed'] }, '"open" | "closed"'],
    [{ type: 'array', items: { type: 'string' } }, 'string[]'],
    [{ type: 'array', items: { enum: ['low', 'high'] } }, '("low" | "high")[]'],
    [{ type: ['string', 'null'] }, 'string | null'],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, 'string | null'],
    [{ $ref: '#/components/schemas/Error' }, 'Error'],
    [{ const: 'ticket.created' }, '"ticket.created"'],
    [{}, 'any'],
  ])('writes %j as %s', (schema, text) => {
    expect(describeType(schema)).toBe(text);
  });
});

describe('constraints', () => {
  it('names lengths, ranges and defaults after the description', () => {
    expect(constraints({ description: 'The subject', minLength: 1, maxLength: 500 })).toBe(
      'The subject; 1–500 characters',
    );
    expect(constraints({ minimum: 1, maximum: 100, default: 25 })).toBe('1–100; default 25');
  });
});

describe('fieldsOf', () => {
  it('flattens nested objects and arrays of objects with dotted names', () => {
    const schema = {
      type: 'object',
      required: ['subject'],
      properties: {
        subject: { type: 'string' },
        contact: { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
        attachments: {
          type: 'array',
          items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    };
    expect(fieldsOf(schema).map((field) => [field.name, field.type, field.required])).toEqual([
      ['subject', 'string', true],
      ['contact', 'object', false],
      ['contact.email', 'string (email)', false],
      ['attachments', 'object[]', false],
      ['attachments[].id', 'string', true],
    ]);
  });
});

describe('endpoints', () => {
  const document: OpenApiDocument = {
    info: { title: 'Helpdock API', version: '1', description: '' },
    tags: [{ name: 'Tickets' }],
    paths: {
      '/api/v1/tickets/{ticketId}': {
        get: {
          operationId: 'getTicket',
          summary: 'Read a ticket',
          tags: ['Tickets'],
          'x-required-scope': 'tickets:read',
          parameters: [
            { name: 'ticketId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
            '404': { description: 'Not found in this brand' },
          },
        },
      },
    },
    webhooks: {},
    components: { securitySchemes: { apiKey: { description: '' } } },
  };

  it('groups operations by tag with their scope, parameters, success and errors', () => {
    const [tickets] = endpoints(document);
    expect(tickets?.tag).toBe('Tickets');
    expect(tickets?.endpoints[0]).toMatchObject({
      method: 'GET',
      path: '/api/v1/tickets/{ticketId}',
      scope: 'tickets:read',
      parameters: [{ name: 'ticketId', location: 'path', required: true }],
      success: { status: '200', fields: [{ name: 'id', type: 'string' }] },
      errors: [{ status: '404', description: 'Not found in this brand' }],
    });
  });
});
