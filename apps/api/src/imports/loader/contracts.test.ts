import { uuidv7 } from '@helpdock/db';
import { expect, it } from 'vitest';
import { ticketLoadSchema } from './contracts.js';

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
