import { expect, it } from 'vitest';
import {
  importContactPreviewQuerySchema,
  importTicketPreviewQuerySchema,
  importTicketPreviewSchema,
} from './import-preview.js';

const ticket = {
  externalId: '42',
  subject: 'History',
  status: 'open',
  ccEmails: [],
  tags: [],
  custom: {},
  createdAt: '2019-01-01T00:00:00Z',
  updatedAt: '2019-01-02T00:00:00Z',
};
const preview = { ticket, messageCount: 0, nextOffset: null, messages: [] };

it('refuses normalized source URLs and attachment download URLs in public preview output', () => {
  expect(importTicketPreviewSchema.safeParse(preview).success).toBe(true);
  expect(
    importTicketPreviewSchema.safeParse({
      ...preview,
      ticket: { ...ticket, sourceUrl: 'https://vendor.test/ticket?token=private' },
    }).success,
  ).toBe(false);
  expect(
    importTicketPreviewSchema.safeParse({
      ...preview,
      messageCount: 1,
      messages: [
        {
          externalId: 'message',
          authorKind: 'system',
          authorExternalId: null,
          sourceAuthorName: null,
          public: true,
          createdAt: ticket.createdAt,
          bodyHtml: '<p>History</p>',
          bodyText: 'History',
          attachments: [
            {
              externalId: 'file',
              fileName: 'history.pdf',
              url: 'https://vendor.test/file?token=private',
            },
          ],
        },
      ],
    }).success,
  ).toBe(false);
});

it('retains ticket date ordering validation when deriving the preview field shape', () => {
  expect(
    importTicketPreviewSchema.safeParse({
      ...preview,
      ticket: { ...ticket, updatedAt: '2018-01-01T00:00:00Z' },
    }).success,
  ).toBe(false);
});

it.each(['\u0000', '42\u0000suffix', '   '])(
  'rejects database-invalid or blank preview lookup ID %j before querying',
  (externalId) => {
    expect(importTicketPreviewQuerySchema.safeParse({ externalId }).success).toBe(false);
    expect(importContactPreviewQuerySchema.safeParse({ externalId }).success).toBe(false);
  },
);
