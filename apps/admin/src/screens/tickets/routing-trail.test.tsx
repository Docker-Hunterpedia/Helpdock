import type { TicketRouting } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.js';
import { RoutingTrail } from './routing-trail.tsx';

const NOW = Date.parse('2026-10-20T14:10:00Z');
const BILLING = {
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000d2',
  name: 'Billing',
  nameAr: 'الفوترة',
};

const emailed: TicketRouting = {
  origin: {
    kind: 'recorded',
    channel: 'email',
    entry: 'mailbox',
    address: 'billing@helpdock.test',
    reason: 'entry_department',
    department: BILLING,
  },
  steps: [
    {
      at: '2026-10-20T14:02:00Z',
      change: {
        kind: 'moved',
        department: BILLING,
        team: { id: '0192c3f0-1a2b-7c3d-8e4f-0000000000e1', name: 'Refunds' },
      },
      by: {
        kind: 'rule',
        ruleId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1',
        name: 'Refunds to the refund team',
      },
    },
    {
      at: '2026-10-20T14:02:00Z',
      change: { kind: 'priority', from: 'medium', to: 'high' },
      by: { kind: 'ai_triage', ruleId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f1', name: null },
    },
    {
      at: '2026-10-20T14:02:30Z',
      change: { kind: 'priority', from: 'high', to: 'low' },
      by: { kind: 'rule', ruleId: '0192c3f0-1a2b-7c3d-8e4f-0000000000f2', name: null },
    },
    {
      at: '2026-10-20T14:03:00Z',
      change: {
        kind: 'assigned',
        assignee: { id: '0192c3f0-1a2b-7c3d-8e4f-00000000000a', name: 'Lina Haddad' },
      },
      by: { kind: 'assignment', mode: 'round_robin' },
    },
  ],
};

const render = (props: Partial<Parameters<typeof RoutingTrail>[0]> = {}) =>
  renderApp(
    <RoutingTrail routing={emailed} failed={false} now={NOW} onRetry={vi.fn()} {...props} />,
  );

afterEach(() => {
  localStorage.clear();
});

describe('collapsed', () => {
  it('reads as one line: entry, the department it ended in and who it was assigned by', () => {
    render();

    expect(screen.getByRole('button', { name: 'How it got here' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(
      screen.getByText(
        (_, node) =>
          node?.tagName === 'P' &&
          node.textContent === 'Email to billing@helpdock.test → Billing · assigned by round-robin',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('says only how a ticket from before 1.1 arrived', () => {
    render({ routing: { origin: { kind: 'unrecorded', channel: 'email' }, steps: [] } });

    expect(screen.getByText('Arrived by email')).toBeInTheDocument();
  });
});

describe('expanded', () => {
  it('lists the arrival, then each automatic step with its source', async () => {
    render();

    await userEvent.click(screen.getByRole('button', { name: 'How it got here' }));

    const steps = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(steps).toEqual([
      "Arrived at billing@helpdock.testBilling · the mailbox's department",
      expect.stringMatching(/^Moved to Billing › Refunds by rule “Refunds to the refund team”/),
      expect.stringMatching(/^Priority raised to High by AI triage/),
      expect.stringMatching(/^Priority lowered to Low by a rule since deleted/),
      expect.stringMatching(/^Assigned to Lina Haddad by round-robin/),
    ]);
  });

  it('reads in Arabic, with the Arabic department name', async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    render();

    await userEvent.click(screen.getByRole('button', { name: 'كيف وصلت إلى هنا' }));

    expect(screen.getByText('الفوترة · قسم صندوق البريد')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[4]?.textContent).toMatch(
      /^أُسندت إلى Lina Haddad بالتناوب/,
    );
  });

  it('says an imported ticket came from its source and nothing ran on it', async () => {
    render({ routing: { origin: { kind: 'imported', source: 'zendesk' }, steps: [] } });

    await userEvent.click(screen.getByRole('button', { name: 'How it got here' }));

    expect(screen.getByRole('listitem')).toHaveTextContent(
      'Imported from ZendeskImports run no rules and assign no one.',
    );
  });

  it('explains why a ticket from before 1.1 has no entry point', async () => {
    render({ routing: { origin: { kind: 'unrecorded', channel: 'chat' }, steps: [] } });

    await userEvent.click(screen.getByRole('button', { name: 'How it got here' }));

    expect(screen.getByRole('listitem')).toHaveTextContent(
      "Arrived by chatBefore 1.1, the entry point wasn't recorded.",
    );
  });
});

describe('when the read fails', () => {
  it('says so and offers to try again', async () => {
    const onRetry = vi.fn();
    render({ routing: undefined, failed: true, onRetry });

    expect(screen.getByText('How this ticket got here could not be read.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('marks the card busy while the read is on its way', () => {
    render({ routing: undefined });

    expect(screen.getByRole('region', { name: 'How it got here' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });
});
