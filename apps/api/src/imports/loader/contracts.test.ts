import { uuidv7 } from '@helpdock/db';
import { expect, it } from 'vitest';
import { mappedTicketLoadSchema, ticketLoadSchema } from './contracts.js';

it('refuses a staged message belonging to another source ticket before loading', () => {
  const input = {
    brandId: uuidv7(),
    runId: uuidv7(),
    source: 'file',
    record: {
      externalId: 'ticket-a',
      subject: 'History',
      status: 'open',
      ccEmails: [],
      tags: [],
      custom: {},
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    resolved: {
      statusId: uuidv7(),
      departmentId: uuidv7(),
      teamId: null,
      priority: 'medium',
      channel: 'manual',
      assigneeId: null,
      contactId: null,
      custom: {},
    },
    authors: {},
    messages: [
      {
        externalId: 'm',
        ticketExternalId: 'ticket-b',
        authorKind: 'system',
        public: false,
        bodyText: 'Note',
        createdAt: '2020-01-01T00:00:00Z',
        attachments: [],
      },
    ],
  };
  expect(ticketLoadSchema.safeParse(input).success).toBe(false);
  input.messages = input.messages.map((message) => ({ ...message, ticketExternalId: 'ticket-a' }));
  expect(ticketLoadSchema.safeParse(input).success).toBe(true);
});

it('requires complete tag and CC decisions and refuses conflicting mappings or duplicate history IDs', () => {
  const input = ticketLoadSchema.parse({
    brandId: uuidv7(),
    runId: uuidv7(),
    source: 'file',
    record: {
      externalId: 'a',
      subject: 'History',
      status: 'open',
      ccEmails: [],
      tags: ['legacy'],
      custom: {},
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    resolved: {
      statusId: uuidv7(),
      departmentId: uuidv7(),
      teamId: null,
      priority: 'medium',
      channel: 'manual',
      assigneeId: null,
      contactId: null,
      custom: {},
    },
    messages: [],
    authors: {},
  });
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  input.resolved.tags = [{ externalValue: 'legacy', tagId: null }];
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(true);
  input.resolved.tags.push({ externalValue: 'legacy', tagId: uuidv7() });
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  input.resolved.tags.pop();
  input.csat = [
    {
      externalId: 'rating',
      ticketExternalId: 'another-ticket',
      rating: 4,
      ratedAt: '2020-01-02T00:00:00Z',
    },
  ];
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  input.csat[0] = {
    ...input.csat[0],
    externalId: 'rating',
    ticketExternalId: 'a',
    rating: 4,
    ratedAt: '2020-01-02T00:00:00Z',
  };
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(true);
  input.csat.push({
    externalId: 'rating',
    ticketExternalId: 'a',
    rating: 4,
    ratedAt: '2020-01-02T00:00:00Z',
  });
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  input.csat = [];
  input.activities = [
    {
      externalId: 'event',
      ticketExternalId: 'other',
      authorKind: 'system',
      action: 'status.changed',
      createdAt: '2020-01-02T00:00:00Z',
    },
  ];
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  const sourceEvent = input.activities[0];
  if (!sourceEvent) throw new Error('Expected source activity fixture');
  const corrected = { ...sourceEvent, ticketExternalId: 'a' };
  input.activities = [corrected];
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(true);
  input.activities.push(corrected);
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  input.activities = [];
  input.record.ccExternalIds = ['source-cc'];
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
  input.resolved.ccContacts = [{ externalId: 'source-cc', contactId: uuidv7() }];
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(true);
  input.resolved.ccContacts.push({ externalId: 'not-requested', contactId: uuidv7() });
  expect(mappedTicketLoadSchema.safeParse(input).success).toBe(false);
});
