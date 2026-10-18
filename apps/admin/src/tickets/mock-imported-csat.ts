import type { TicketActivityEntry, TicketCsat } from '@helpdock/schemas';

export const MOCK_IMPORTED_CSAT: TicketCsat = {
  state: 'imported_unscored',
  rating: null,
  comment: null,
  link: null,
  expiresAt: '1970-01-01T00:00:00Z',
  ratedAt: '2020-02-02T17:09:45.703Z',
  originalAnswers: [
    { question_id: 'Q_1', question_text: 'How was the support?', value: 7 },
    {
      question_id: 'Q_23',
      question_text: 'Your feedback',
      value: 'The complete original answer is retained.',
    },
  ],
};

export function mockImportedCsatEvent(ticketId: string): TicketActivityEntry {
  return {
    id: '0192c3f0-1a2b-7c3d-8e4f-00000000c5a7',
    ticketId,
    actorType: 'system',
    actorId: 'import:freshdesk:system',
    action: 'ticket.imported.event',
    via: 'system',
    createdAt: MOCK_IMPORTED_CSAT.ratedAt ?? '',
    from: null,
    to: {
      csat: MOCK_IMPORTED_CSAT,
      changes: {},
      sourceEvent: {
        source: 'freshdesk',
        action: 'csat.response',
        externalId: 'modern:example:response',
      },
    },
  };
}
