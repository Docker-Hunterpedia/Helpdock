import { importMessageSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { toEmailView } from '../../channels/email-view.js';
import { importEmailMeta } from './email-meta.js';

it.each([
  { sentAt: undefined, expected: '2019-01-01T09:00:00.000Z' },
  { sentAt: '2018-12-31T23:30:00+03:00', expected: '2018-12-31T20:30:00.000Z' },
  { sentAt: null, expected: null },
])(
  'keeps original mail headers and uses mail date $sentAt without inventing a missing date',
  ({ sentAt, expected }) => {
    const message = importMessageSchema.parse({
      externalId: 'm',
      ticketExternalId: 't',
      authorKind: 'customer',
      public: true,
      bodyText: 'Hello',
      attachments: [],
      createdAt: '2019-01-01T12:00:00+03:00',
      email: {
        from: 'sender@example.com',
        to: ['desk@example.com'],
        cc: ['copy@example.com'],
        sentAt,
      },
    });
    expect(toEmailView(importEmailMeta(message))).toMatchObject({
      from: { address: 'sender@example.com' },
      to: [{ address: 'desk@example.com' }],
      cc: [{ address: 'copy@example.com' }],
      date: expected,
      remoteImages: { count: 0, policy: 'block' },
    });
  },
);
