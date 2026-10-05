import type { ChannelStatus } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { healthySystemStatus } from './fixtures.js';
import { AuditCard, ChannelsCard } from './side-cards.tsx';

/**
 * The Channels and Audit log panels, driven directly — the shapes M2, M6, M1 and M7
 * will send are testable long before those milestones can produce them.
 */

const channel = (overrides: Partial<ChannelStatus> = {}): ChannelStatus => ({
  id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c1',
  name: 'Support mailbox',
  kind: 'email',
  status: 'ok',
  detail: 'polled 12 s ago',
  checkedAt: new Date().toISOString(),
  ...overrides,
});

describe('ChannelsCard', () => {
  it('lists a channel under its kind with its last check', () => {
    renderApp(<ChannelsCard channels={[channel()]} />);

    const card = screen.getByRole('region', { name: 'Channels' });
    const mailboxes = within(card).getByRole('list', { name: 'Mailboxes' });
    expect(within(mailboxes).getByText('Support mailbox')).toBeVisible();
    expect(within(mailboxes).getByText('polled 12 s ago')).toBeVisible();
    expect(within(card).getByText('All brands · 1 connection')).toBeVisible();
    expect(within(card).queryByText(/need attention|needs attention/)).not.toBeInTheDocument();
  });

  it('shows a failing channel without relying on the hue alone', () => {
    renderApp(
      <ChannelsCard
        channels={[
          channel({ status: 'error', detail: 'auth failed' }),
          channel({
            id: '0192c3f0-1a2b-7c3d-8e4f-0000000000c2',
            name: 'Bot',
            kind: 'telegram',
          }),
        ]}
      />,
    );

    const card = screen.getByRole('region', { name: 'Channels' });
    expect(within(card).getByText('auth failed')).toBeVisible();
    expect(within(card).getByText('1 needs attention')).toBeVisible();
    expect(within(card).getByRole('list', { name: 'Mailboxes' })).toBeVisible();
    expect(within(card).getByRole('list', { name: 'Telegram bots' })).toBeVisible();
  });
});

describe('AuditCard', () => {
  it('says so when nothing has been recorded', () => {
    renderApp(<AuditCard audit={[]} />);

    expect(screen.getByText('Nothing has been recorded yet.')).toBeVisible();
  });

  it('shows the newest three rows and opens the full audit log', () => {
    const entry = healthySystemStatus().audit[0];
    if (entry === undefined) {
      throw new Error('the fixture carries an audit row');
    }

    const audit = Array.from({ length: 5 }, (_unused, index) => ({
      ...entry,
      id: `0192c3f0-1a2b-7c3d-8e4f-00000000000${index}`,
      action: `install.scope.access.${index}`,
    }));

    renderApp(<AuditCard audit={audit} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/admin/system/audit-log',
    );
  });
});
