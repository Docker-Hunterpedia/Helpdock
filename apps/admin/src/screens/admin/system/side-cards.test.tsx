import type { ChannelStatus, SystemAiSpend, SystemStorage } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../test/render.tsx';
import { healthySystemStatus } from './fixtures.js';
import { AuditCard, ChannelsCard, UsageCard } from './side-cards.tsx';

/**
 * The three end-column panels, driven directly — the shapes M2, M6, M1 and M7
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
  it('lists a channel with its kind and its last check', () => {
    renderApp(<ChannelsCard channels={[channel()]} />);

    const card = screen.getByRole('region', { name: 'Channels' });
    expect(within(card).getByText('Support mailbox · email')).toBeVisible();
    expect(within(card).getByText('polled 12 s ago')).toBeVisible();
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
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('UsageCard', () => {
  const configuredStorage: SystemStorage = {
    configured: true,
    usedBytes: 19_756_775_014,
    softLimitBytes: 53_687_091_200,
  };

  const configuredSpend: SystemAiSpend = {
    configured: true,
    tokens: 2_100_000,
    costUsd: 6.4,
    budgetUsd: 10,
    alertAtPercent: 80,
  };

  it('shows the measurements and their limits once both are configured', () => {
    renderApp(<UsageCard storage={configuredStorage} aiSpend={configuredSpend} />);

    const card = screen.getByRole('region', { name: 'Storage and AI spend' });
    expect(within(card).getByText('18.4 GB')).toBeVisible();
    expect(within(card).getByText('of 50.0 GB soft limit')).toBeVisible();
    expect(within(card).getByText('2.1 M · $6.40')).toBeVisible();
    expect(within(card).getByText('64 % of the $10.00 budget · alert at 80 %')).toBeVisible();
    expect(within(card).queryByText('Not configured')).not.toBeInTheDocument();
  });

  it('shows a measurement with no limit without inventing one', () => {
    renderApp(
      <UsageCard
        storage={{ configured: true, usedBytes: 1024, softLimitBytes: null }}
        aiSpend={{
          configured: true,
          tokens: 10,
          costUsd: 0,
          budgetUsd: null,
          alertAtPercent: null,
        }}
      />,
    );

    const card = screen.getByRole('region', { name: 'Storage and AI spend' });
    expect(within(card).getByText('1.0 KB')).toBeVisible();
    expect(
      within(card).getByText('Attachment storage is measured from milestone M1.'),
    ).toBeVisible();
  });
});

describe('AuditCard', () => {
  it('says so when nothing has been recorded', () => {
    renderApp(<AuditCard audit={[]} />);

    expect(screen.getByText('Nothing has been recorded yet.')).toBeVisible();
  });

  it('shows three rows and the rest on request', async () => {
    const entry = healthySystemStatus().audit[0];
    if (entry === undefined) {
      throw new Error('the fixture carries an audit row');
    }

    const audit = Array.from({ length: 5 }, (_unused, index) => ({
      ...entry,
      id: `0192c3f0-1a2b-7c3d-8e4f-00000000000${index}`,
      action: `install.scope.access.${index}`,
    }));

    const { user } = renderApp(<AuditCard audit={audit} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: 'Show all' }));

    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});
