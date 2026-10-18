import { type ImportMessage, importMessageSchema } from '@helpdock/schemas';
import { expect, it } from 'vitest';
import { importMessageDetails, importMessageHash } from './load-messages.js';

it('retains source-only attribution and historical transport facts without promoting the display name to an agent identity', () => {
  const message = importMessageSchema.parse({
    externalId: 'source-only',
    ticketExternalId: 'ticket',
    authorKind: 'system',
    authorName: 'Original name',
    public: false,
    bodyText: 'History',
    createdAt: '2020-01-01T00:00:00Z',
    attachments: [],
  });
  expect(importMessageDetails(message)).toEqual({ authorKind: 'unknown' });
  const original = {
    ...message,
    sourceDetails: { status: 'FAILED', authorKind: 'customer' as const, channel: 'EMAIL' },
    via: 'zoho:EMAIL:out:FAILED',
  };
  expect(importMessageDetails(original)).toEqual({
    status: 'FAILED',
    authorKind: 'customer',
    channel: 'EMAIL',
    via: 'zoho:EMAIL:out:FAILED',
  });
  expect(importMessageHash(original)).not.toBe(
    importMessageHash({
      ...original,
      sourceDetails: { ...original.sourceDetails, status: 'DRAFT' },
    }),
  );
});

it('treats a refreshed URL or moved source page as transport metadata while detecting actual historical edits', () => {
  const original: ImportMessage = importMessageSchema.parse({
    externalId: 'source-message',
    ticketExternalId: 'source-ticket',
    authorKind: 'customer',
    public: true,
    bodyText: 'Original history',
    createdAt: '2020-01-01T00:00:00Z',
    attachments: [
      {
        externalId: 'source-file',
        fileName: 'history.pdf',
        contentType: 'application/pdf',
        size: 200,
        url: 'https://cdn.example.test/file?token=old',
        sourcePage: 10,
      },
    ],
  });
  const relocated = {
    ...original,
    attachments: original.attachments.map((attachment) => ({
      ...attachment,
      sourcePage: 12,
      url: 'https://cdn.example.test/file?token=new',
    })),
  };
  expect(importMessageHash(relocated)).toBe(importMessageHash(original));
  expect(importMessageHash({ ...relocated, bodyText: 'Edited history' })).not.toBe(
    importMessageHash(original),
  );
  expect(
    importMessageHash({
      ...relocated,
      attachments: relocated.attachments.map((attachment) => ({
        ...attachment,
        size: 201,
      })),
    }),
  ).not.toBe(importMessageHash(original));
});
