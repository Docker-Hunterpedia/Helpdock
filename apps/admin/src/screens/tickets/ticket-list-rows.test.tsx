import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { NOW, testStatus, testTicket } from '../../tickets/fixtures.js';
import { EMPTY_FILTERS } from '../../tickets/views.js';
import { TicketList } from './ticket-list.tsx';

/**
 * What the list hands each row (M14-20): the assignee's name from the ticket
 * itself, because an Agent cannot read the staff list, and a status word that
 * is hidden only on rows that have the view's one status.
 */

const OPEN = testStatus();
const ESCALATED = testStatus({
  id: '0192c3f0-1a2b-7c3d-8e4f-000000000052',
  name: 'Escalated',
  systemState: 'escalated',
  isDefault: false,
  color: 'escalated',
});
const LINA = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';

const renderList = (tickets: ReturnType<typeof testTicket>[], statusId: string[] = []) =>
  renderApp(
    <TicketList
      heading="Tickets"
      tickets={tickets}
      selectedId={null}
      now={NOW}
      search=""
      emptyKind="plain"
      typed=""
      filters={{ ...EMPTY_FILTERS, statusId }}
      statuses={[OPEN, ESCALATED]}
      departments={[]}
      tags={[]}
      staff={[]}
      fields={[]}
      pinnedField={undefined}
      viewerId={LINA}
      changes={null}
      openFiltersToken={null}
      hasMore={false}
      loading={false}
      failed={false}
      linkSearch=""
      onTypedChange={vi.fn()}
      onFiltersChange={vi.fn()}
      onLoadMore={vi.fn()}
      onRetry={vi.fn()}
      onNewTicket={vi.fn()}
    />,
  );

describe('the rows of the list (M14-20)', () => {
  it('names the assignee from the ticket when the staff list is empty', () => {
    renderList([testTicket({ assigneeId: LINA, assignee: { id: LINA, name: 'Lina Haddad' } })]);

    expect(screen.getByText('LH')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Assigned to Lina Haddad$/ })).toBeInTheDocument();
  });

  it('hides the status only on rows that have the view’s one status', () => {
    renderList(
      [
        testTicket({ id: 'a', subject: 'Escalated one', status: ESCALATED }),
        testTicket({ id: 'b', subject: 'Named by the search', status: OPEN }),
      ],
      [ESCALATED.id],
    );

    // Subject, reference, then the time and the assignee: no status between.
    expect(
      screen.getByRole('link', { name: /Escalated one HD-\d+ \d+h Unassigned$/ }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: /Named by the search.*Open/ })).toBeInTheDocument();
  });
});
