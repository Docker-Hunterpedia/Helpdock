import { importMessageSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { toEmailView } from '../../channels/email-view.js';
import { importEmailMeta } from './email-meta.js';

it('keeps original mail headers in a shape the existing thread can display', () => {
  const message = importMessageSchema.parse({
    externalId: 'm',
    ticketExternalId: 't',
    authorKind: 'customer',
    public: true,
    bodyText: 'Hello',
    attachments: [],
    createdAt: '2019-01-01T12:00:00+03:00',
    email: { from: 'sender@example.com', to: ['desk@example.com'], cc: ['copy@example.com'] },
  });
  expect(toEmailView(importEmailMeta(message))).toMatchObject({
    from: { address: 'sender@example.com' },
    to: [{ address: 'desk@example.com' }],
    cc: [{ address: 'copy@example.com' }],
    date: '2019-01-01T09:00:00.000Z',
    remoteImages: { count: 0, policy: 'block' },
  });
});
