import { hashImportValue } from '@helpdock/importers';
import { expect, it } from 'vitest';
import { validatedStagedRecord } from './staged-record.js';

const payload = {
  externalId: 'message',
  ticketExternalId: 'ticket',
  authorKind: 'system',
  public: true,
  bodyText: 'Original reply',
  createdAt: '2020-01-01T00:00:00Z',
  attachments: [],
};
const staged = {
  entity: 'message' as const,
  externalId: 'message',
  parentExternalId: 'ticket',
  payload,
  payloadHash: hashImportValue(payload),
  status: 'staged' as const,
};
it.each([
  { payload: { ...payload, bodyText: 'Tampered reply' } },
  { externalId: 'different-message' },
  { parentExternalId: 'different-ticket' },
  { status: 'failed' as const },
])('refuses staged integrity mismatch %j without exposing source text', (change) => {
  expect(() => validatedStagedRecord({ ...staged, ...change })).toThrow('mapping-invalid');
});
it('returns the validated original message while retaining its historical content', () => {
  expect(validatedStagedRecord(staged)).toEqual({ entity: 'message', payload });
});
