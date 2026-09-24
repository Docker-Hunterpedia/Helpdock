import { screen, within } from '@testing-library/react';
import { Ban, Timer } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { NOW, testTicket } from '../../tickets/fixtures.js';
import type { TicketAction } from './ticket-actions-menu.tsx';
import { type HeaderViewer, TicketHeader } from './ticket-header.tsx';

/**
 * The two things M1-09 changed in the header: the collision pill tells
 * "viewing" from "replying", and the ⋯ menu draws whatever entries it is
 * handed — which is the seam M1-11 and M1-12 add theirs through.
 */

const renderHeader = (viewers: readonly HeaderViewer[], actions: readonly TicketAction[] = []) =>
  renderApp(
    <TicketHeader
      ticket={testTicket()}
      departmentName="Billing"
      viewers={viewers}
      actions={actions}
      now={NOW}
      showDetailsButton={false}
      onShowDetails={() => {}}
    />,
  );

describe('the collision pill', () => {
  it('says somebody is replying when their composer has something in it', () => {
    renderHeader([{ name: 'Omar Nasser', activity: 'replying' }]);

    expect(screen.getByRole('status')).toHaveTextContent('Omar Nasser is replying');
  });

  it('counts the others behind the one replying', () => {
    renderHeader([
      { name: 'Omar Nasser', activity: 'replying' },
      { name: 'Yara Saleh', activity: 'viewing' },
    ]);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Omar Nasser is replying · 1 more viewing',
    );
  });

  it('says viewing when nobody is writing', () => {
    renderHeader([{ name: 'Yara Saleh', activity: 'viewing' }]);

    expect(screen.getByRole('status')).toHaveTextContent('Yara Saleh is viewing');
  });

  it('draws nothing when nobody else is here', () => {
    renderHeader([]);

    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the ⋯ menu', () => {
  it('is disabled when there is nothing to offer', () => {
    renderHeader([]);

    expect(screen.getByRole('button', { name: 'More actions' })).toBeDisabled();
  });

  it('draws the entries it is given, in order, and runs the one chosen', async () => {
    const logTime = vi.fn();
    const { user } = renderHeader(
      [],
      [
        { id: 'log', label: 'Log time…', icon: Timer, onSelect: logTime },
        {
          id: 'spam',
          label: 'Mark as spam',
          icon: Ban,
          tone: 'danger',
          dividerBefore: true,
          onSelect: () => {},
        },
      ],
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu', { name: 'Ticket actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Log time…', 'Mark as spam']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Log time…' }));
    expect(logTime).toHaveBeenCalledOnce();
  });
});
