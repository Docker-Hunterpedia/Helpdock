import type { RelatedTicket } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { MOCK_STATUS_CLOSED, MockTicketsApi } from '../../tickets/mock-api.js';
import { LinkedTickets } from './linked-tickets.tsx';

/**
 * The details panel's Linked tickets (panel 6 of `Admin · view dialogs`): a
 * card per ticket the reader can open, and a locked line — with nothing that
 * names the ticket — for one they cannot.
 */

const closed = async () => {
  const { statuses } = await new MockTicketsApi().statuses('brand');
  const status = statuses.find((row) => row.id === MOCK_STATUS_CLOSED);
  if (status === undefined) {
    throw new Error('the fixture seeds a Closed status');
  }

  return status;
};

describe('LinkedTickets', () => {
  it('says None when nothing is linked', () => {
    renderApp(<LinkedTickets related={[]} />);

    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('opens a visible link, named by reference, status, subject and relation', async () => {
    const related: RelatedTicket[] = [
      {
        visible: true,
        relation: 'parent',
        id: 't-0988',
        number: 988,
        prefix: 'HD',
        subject: 'Earlier return question',
        status: await closed(),
      },
    ];
    renderApp(<LinkedTickets related={related} />);

    const link = screen.getByRole('link', { name: /HD-988/ });
    expect(link).toHaveAttribute('href', '/tickets/t-0988');
    expect(link).toHaveTextContent('Closed');
    expect(link).toHaveTextContent('Earlier return question');
    expect(link).toHaveTextContent('Parent · continued from');
  });

  it('draws a hidden link as the locked line, with no link and nothing to name it', () => {
    renderApp(<LinkedTickets related={[{ visible: false, relation: 'splitTo' }]} />);

    const item = screen.getByRole('listitem');
    expect(within(item).queryByRole('link')).toBeNull();
    expect(item).toHaveTextContent('A ticket you cannot open');
    expect(item).toHaveTextContent('Split to · hidden from you');
    expect(item.textContent).not.toMatch(/HD-/);
  });
});
