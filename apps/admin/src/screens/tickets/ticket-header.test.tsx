import { screen, within } from '@testing-library/react';
import { Ban, Timer } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
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

it.each(['en', 'ar'] as const)(
  'shows the original source number with a query-free, isolated source link in %s',
  (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    renderApp(
      <TicketHeader
        ticket={{
          ...testTicket(),
          imported: {
            source: 'zendesk',
            number: '0039812',
            url: 'https://support.example/agent/tickets/39812?token=private#secret',
          },
        }}
        departmentName="Billing"
        viewers={[]}
        actions={[]}
        now={NOW}
        showDetailsButton={false}
        onShowDetails={() => {}}
      />,
    );
    const source = screen.getByRole('link', { name: /Zendesk.*0039812/ });
    expect(source).toHaveAttribute('href', 'https://support.example/agent/tickets/39812');
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
  },
);

it('keeps provenance visible without making an unsafe source address clickable', () => {
  renderApp(
    <TicketHeader
      ticket={{
        ...testTicket(),
        imported: { source: 'file', number: 'old-42', url: 'javascript:alert(1)' },
      }}
      departmentName="Billing"
      viewers={[]}
      actions={[]}
      now={NOW}
      showDetailsButton={false}
      onShowDetails={() => {}}
    />,
  );
  expect(screen.getByText(/old-42/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /old-42/ })).not.toBeInTheDocument();
});

it('lets the subject take its own direction, whatever the page’s is', () => {
  renderHeader([]);

  expect(screen.getByRole('heading', { level: 1, name: 'Refund for order 42' })).toHaveAttribute(
    'dir',
    'auto',
  );
});

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

describe('the pinned field (M14-16)', () => {
  const severity = {
    id: 'f-severity',
    target: 'ticket' as const,
    key: 'severity',
    label: 'Severity',
    labelAr: 'الخطورة',
    type: 'select' as const,
    options: ['Sev 1', 'Sev 2'],
    required: false,
    agentVisible: true,
    requiredToClose: false,
    pinned: true,
    sortOrder: 0,
  };

  const renderPinned = (custom: Record<string, unknown>) =>
    renderApp(
      <TicketHeader
        ticket={testTicket({ custom })}
        departmentName="Billing"
        viewers={[]}
        actions={[]}
        now={NOW}
        showDetailsButton={false}
        pinnedField={severity}
        onShowDetails={() => {}}
      />,
    );

  it('shows the value as a chip beside the priority, named for a screen reader', () => {
    renderPinned({ severity: 'Sev 1' });

    expect(screen.getByText('Sev 1')).toBeInTheDocument();
    expect(screen.getByText('Severity:')).toBeInTheDocument();
  });

  it('draws nothing for a ticket that has no value, or one that is not text', () => {
    renderPinned({ severity: null, other: 'Sev 1' });

    expect(screen.queryByText('Sev 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Severity:')).not.toBeInTheDocument();
  });
});
