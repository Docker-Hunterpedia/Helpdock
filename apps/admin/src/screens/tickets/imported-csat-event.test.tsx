import type { TicketActivityEntry } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderApp } from '../../test/render.js';
import { MOCK_IMPORTED_CSAT, mockImportedCsatEvent } from '../../tickets/mock-imported-csat.js';
import { ImportedCsatEvent } from './imported-csat-event.js';

const event = mockImportedCsatEvent('0193b000-0000-7000-8000-000000000913');
it('shows the original question values in an inert history card', () => {
  renderApp(<ImportedCsatEvent entry={event} />);
  expect(screen.getByText('How was the support?')).toBeInTheDocument();
  expect(screen.getByText('7')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('reads original answers preserved by the upgrade without adding a live survey link', () => {
  const { originalAnswers, ...summary } = MOCK_IMPORTED_CSAT;
  const upgraded = {
    ...event,
    to: { csat: summary, sourceEvent: { details: { originalAnswers } } },
  };
  renderApp(<ImportedCsatEvent entry={upgraded} />);
  expect(screen.getByText('How was the support?')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it.each([
  { ...event, action: 'ticket.status.changed' },
  { ...event, to: { csat: {} } },
  { ...event, to: { csat: { ...MOCK_IMPORTED_CSAT, link: 'https://example.test/live-survey' } } },
])(
  'does not render malformed, native or sendable history as an imported answer',
  (entry: TicketActivityEntry) => {
    const { container } = renderApp(<ImportedCsatEvent entry={entry} />);
    expect(container.querySelector('section')).toBeNull();
  },
);
