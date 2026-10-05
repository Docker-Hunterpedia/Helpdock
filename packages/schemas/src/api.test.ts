import { describe, expect, it } from 'vitest';
import {
  apiKeyCreateRequestSchema,
  idempotencyKeySchema,
  v1TicketCreateRequestSchema,
  webhookCreateRequestSchema,
  webhookUpdateRequestSchema,
} from './api.js';

const ID = '0192a000-0000-7000-8000-000000000001';

describe('apiKeyCreateRequestSchema', () => {
  it('takes a name and at least one known scope, each once', () => {
    expect(
      apiKeyCreateRequestSchema.safeParse({ name: 'CRM', scopes: ['tickets:read'] }).success,
    ).toBe(true);
    expect(apiKeyCreateRequestSchema.safeParse({ name: 'CRM', scopes: [] }).success).toBe(false);
    expect(
      apiKeyCreateRequestSchema.safeParse({ name: 'CRM', scopes: ['ticket:read'] }).success,
    ).toBe(false);
    expect(
      apiKeyCreateRequestSchema.safeParse({ name: 'CRM', scopes: ['tickets:read', 'tickets:read'] })
        .success,
    ).toBe(false);
  });
});

describe('webhookCreateRequestSchema', () => {
  it.each([
    ['https://hooks.example.com/helpdock', true],
    ['http://hooks.example.com/helpdock', true],
    ['ftp://hooks.example.com/helpdock', false],
    ['https://user:pass@hooks.example.com/helpdock', false],
    ['not a url', false],
  ])('%s is %s', (url, ok) => {
    expect(webhookCreateRequestSchema.safeParse({ url, events: ['ticket.created'] }).success).toBe(
      ok,
    );
  });

  it('takes only the events of REQUIREMENTS §4.12', () => {
    expect(
      webhookCreateRequestSchema.safeParse({
        url: 'https://hooks.example.com',
        events: ['ticket.deleted'],
      }).success,
    ).toBe(false);
  });

  it('refuses an update that changes nothing', () => {
    expect(webhookUpdateRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('v1TicketCreateRequestSchema', () => {
  it('needs a subject, body and department unless a template supplies them', () => {
    expect(v1TicketCreateRequestSchema.safeParse({ subject: 'Refund' }).success).toBe(false);
    expect(v1TicketCreateRequestSchema.safeParse({ templateId: ID }).success).toBe(true);
  });

  it('has no channel: a ticket filed through the API is on the api channel', () => {
    const parsed = v1TicketCreateRequestSchema.parse({
      subject: 'Refund',
      bodyHtml: '<p>Hi</p>',
      departmentId: ID,
      channel: 'email',
    });

    expect(parsed).not.toHaveProperty('channel');
  });
});

describe('idempotencyKeySchema', () => {
  it('takes printable ASCII without spaces, up to 255 characters', () => {
    expect(idempotencyKeySchema.safeParse('order-1042:attempt').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('has space').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(256)).success).toBe(false);
  });
});
