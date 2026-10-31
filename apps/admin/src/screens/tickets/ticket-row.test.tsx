import type { TicketAiState } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { HOUR, NOW, testTicket } from '../../tickets/fixtures.js';
import { TicketRow } from './ticket-row.tsx';

/**
 * What the ticket list says about the assistant on a row (M7-06,
 * `Admin/Ticket-AI`): "AI paused" while the conversation is handed off, "AI
 * answered" once the assistant sent an answer and is not paused, nothing when
 * it never answered.
 */

const AT = '2026-10-05T09:18:00.000Z';
const HANDED_BACK: TicketAiState = {
  pausedAt: null,
  pausedUntil: null,
  reason: null,
  answeredAt: null,
};
const ANSWERED: TicketAiState = { ...HANDED_BACK, answeredAt: AT };
const PAUSED: TicketAiState = { ...HANDED_BACK, pausedAt: AT, reason: 'low_confidence' };
const CAPTIONS = ['AI paused', 'AI answered'];

const captionsOnRow = (ai: TicketAiState | undefined): string[] => {
  renderApp(
    <ul>
      <TicketRow
        ticket={testTicket({ ...(ai === undefined ? {} : { ai }) })}
        selected={false}
        now={NOW}
        search=""
      />
    </ul>,
  );

  return CAPTIONS.filter((caption) => screen.queryByText(caption) !== null);
};

describe('the subject on a ticket row', () => {
  it('takes its own direction, so an English subject in the Arabic admin keeps its punctuation', () => {
    renderApp(
      <ul>
        <TicketRow
          ticket={testTicket({ subject: 'Do you ship to Ireland?' })}
          selected={false}
          now={NOW}
          search=""
        />
      </ul>,
    );

    expect(screen.getByText('Do you ship to Ireland?')).toHaveAttribute('dir', 'auto');
  });
});

describe('what a screen reader hears of a row', () => {
  it('names the link by everything on it: priority, subject, reference, contact, status and SLA', () => {
    renderApp(
      <ul>
        <TicketRow
          ticket={testTicket({
            priority: 'urgent',
            contact: { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1', name: 'Mona Khalil' },
            firstResponseDueAt: new Date(NOW + 4 * HOUR).toISOString(),
          })}
          selected={false}
          now={NOW}
          search=""
        />
      </ul>,
    );

    // DESIGN §10: the dot's colour is not the only place the priority is said,
    // and the row's bare `4h` is said as what it is.
    expect(
      screen.getByRole('link', {
        name: /^Urgent priority Refund for order 42 HD-1042 Mona Khalil Open 4h left/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-label');
  });
});

describe('the assistant on a ticket row', () => {
  it.each([
    ['a handed-off conversation is marked "AI paused", not answered', PAUSED, ['AI paused']],
    [
      'a conversation the assistant answered and still holds is marked "AI answered"',
      ANSWERED,
      ['AI answered'],
    ],
    [
      'a conversation answered and then handed off is marked "AI paused" alone',
      { ...PAUSED, answeredAt: AT },
      ['AI paused'],
    ],
    [
      'a conversation handed back to the assistant before it ever answered says nothing',
      HANDED_BACK,
      [],
    ],
    ['a ticket the assistant never took part in says nothing', undefined, []],
  ])('%s', (_scenario, ai, expected) => {
    expect(captionsOnRow(ai)).toEqual(expected);
  });
});

describe('a snoozed row (M14-02)', () => {
  const snoozedUntil = new Date(NOW + 3 * 24 * HOUR).toISOString();

  it('shows a clock and the wake time where the SLA timer was', () => {
    renderApp(
      <ul>
        <TicketRow
          ticket={testTicket({
            snoozedUntil,
            firstResponseDueAt: new Date(NOW - HOUR).toISOString(),
          })}
          selected={false}
          now={NOW}
          search=""
        />
      </ul>,
    );

    const label = screen.getByLabelText(/^Snoozed until /);
    expect(label.querySelector('svg')).not.toBeNull();
    expect(label.querySelector('bdi')).not.toBeNull();
    // The SLA timer is the reason it is replaced: a breached clock would read "overdue".
    expect(screen.queryByText(/over/i)).not.toBeInTheDocument();
  });

  it('shows the SLA timer for a ticket that is not snoozed', () => {
    renderApp(
      <ul>
        <TicketRow ticket={testTicket()} selected={false} now={NOW} search="" />
      </ul>,
    );

    expect(screen.queryByLabelText(/^Snoozed until /)).not.toBeInTheDocument();
  });
});

describe('the checkbox on a row (M14-04)', () => {
  const renderSelectable = (checked: boolean, onSelect = vi.fn()) =>
    renderApp(
      <ul>
        <TicketRow
          ticket={testTicket()}
          selected={false}
          now={NOW}
          search=""
          selection={{ checked, onSelect }}
        />
      </ul>,
    );

  it('is named by the reference, and is not part of the link’s name', () => {
    renderSelectable(false);

    expect(screen.getByRole('checkbox', { name: 'Select HD-1042' })).not.toBeChecked();
    expect(
      screen.getByRole('link', { name: /^Medium priority Refund for order 42 HD-1042/ }),
    ).toBeVisible();
    expect(screen.getByRole('link').closest('li')).toContainElement(screen.getByRole('checkbox'));
    expect(screen.getByRole('link')).not.toContainElement(screen.getByRole('checkbox'));
  });

  it('shows a ticked row ticked', () => {
    renderSelectable(true);

    expect(screen.getByRole('checkbox', { name: 'Select HD-1042' })).toBeChecked();
  });

  it('reports a plain click and a Shift-click apart', async () => {
    const onSelect = vi.fn();
    const { user } = renderSelectable(false, onSelect);

    await user.click(screen.getByRole('checkbox'));
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox'));
    await user.keyboard('{/Shift}');

    expect(onSelect.mock.calls).toEqual([[false], [true]]);
  });

  it('draws no checkbox without a selection, so a reader who cannot write has none', () => {
    renderApp(
      <ul>
        <TicketRow ticket={testTicket()} selected={false} now={NOW} search="" />
      </ul>,
    );

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('carries the ticket id for the shortcuts to find the focused row', () => {
    renderSelectable(false);

    expect(screen.getByRole('checkbox').closest('li')).toHaveAttribute(
      'data-ticket-id',
      testTicket().id,
    );
  });
});

describe('the pinned field on a row (M14-16)', () => {
  const plan = {
    id: 'f-plan',
    target: 'ticket' as const,
    key: 'plan',
    label: 'Plan',
    labelAr: null,
    type: 'select' as const,
    options: ['Pro', 'Free'],
    required: false,
    agentVisible: true,
    requiredToClose: false,
    pinned: true,
    sortOrder: 0,
  };
  const row = (custom: Record<string, unknown>, pinnedField: typeof plan | null = plan) =>
    renderApp(
      <ul>
        <TicketRow
          ticket={testTicket({ custom })}
          selected={false}
          now={NOW}
          search=""
          pinnedField={pinnedField ?? undefined}
        />
      </ul>,
    );

  it('puts the value on the caption line and in the link’s accessible name', () => {
    row({ plan: 'Pro' });

    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Plan: Pro/ })).toBeInTheDocument();
  });

  it('adds nothing when the ticket has no value, or when no field is pinned', () => {
    const { unmount } = row({});
    expect(screen.queryByText('Plan:')).not.toBeInTheDocument();
    unmount();

    row({ plan: 'Pro' }, null);
    expect(screen.queryByText('Pro')).not.toBeInTheDocument();
  });
});

describe('the meta line and the assignee on a row (M14-20)', () => {
  const MONA = { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1', name: 'Mona Khalil' };
  const LINA = '0192c3f0-1a2b-7c3d-8e4f-0000000000a1';

  const row = (
    ticket = testTicket(),
    props: { assigneeName?: string | null; hideStatus?: boolean } = {},
  ) =>
    renderApp(
      <ul>
        <TicketRow ticket={ticket} selected={false} now={NOW} search="" {...props} />
      </ul>,
    );

  it('puts reference, contact, status and the SLA time on one line, in that order', () => {
    row(
      testTicket({
        contact: MONA,
        firstResponseDueAt: new Date(NOW + 4 * HOUR).toISOString(),
      }),
    );

    const line = screen.getByText('HD-1042').closest('p');
    expect(line).not.toBeNull();
    expect(line?.textContent).toMatch(/^HD-1042·Mona Khalil·Open.*4h/);
  });

  it('draws the status as a word, not a pill', () => {
    row();

    expect(screen.getByText('Open').closest('p')).not.toBeNull();
  });

  it('leaves the status out when the view is filtered to one status', () => {
    row(testTicket({ firstResponseDueAt: new Date(NOW + 4 * HOUR).toISOString() }), {
      hideStatus: true,
    });

    expect(screen.queryByText('Open')).not.toBeInTheDocument();
    expect(screen.getByRole('link').textContent).not.toMatch(/Open/);
    expect(screen.getByRole('link', { name: /4h left/ })).toBeInTheDocument();
  });

  it('shows the assignee as initials and says their name in the link', () => {
    row(testTicket({ assigneeId: LINA }), { assigneeName: 'Lina Haddad' });

    expect(screen.getByText('LH')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('link', { name: /Assigned to Lina Haddad$/ })).toBeInTheDocument();
  });

  it('draws a dashed ring and says "Unassigned" when nobody has the ticket', () => {
    row(testTicket({ assigneeId: null }));

    const link = screen.getByRole('link');
    expect(link).toHaveAccessibleName(/Unassigned$/);
    // The priority dot is the first empty drawing; the ring is the last.
    const ring = [...link.querySelectorAll('span[aria-hidden="true"]:empty')].at(-1);
    expect(ring).not.toBeNull();
    expect(getComputedStyle(ring as Element).borderStyle).toBe('dashed');
  });

  it('says "Assigned" when the assignee is not in the staff list', () => {
    row(testTicket({ assigneeId: LINA }), { assigneeName: null });

    expect(screen.getByRole('link', { name: /Assigned$/ })).toBeInTheDocument();
  });

  it('names the link by status, SLA and assignee together', () => {
    row(
      testTicket({
        assigneeId: LINA,
        firstResponseDueAt: new Date(NOW + 4 * HOUR).toISOString(),
      }),
      { assigneeName: 'Lina Haddad' },
    );

    expect(
      screen.getByRole('link', { name: /Open 4h left.* Assigned to Lina Haddad$/ }),
    ).toBeInTheDocument();
  });
});
