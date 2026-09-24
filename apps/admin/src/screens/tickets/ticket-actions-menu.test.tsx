import { screen } from '@testing-library/react';
import { GitMerge, ShieldAlert } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { TicketActionsMenu } from './ticket-actions-menu.tsx';

/**
 * The ⋯ menu draws whatever items it is handed, in order, with a separator
 * only where one separates something.
 */

describe('TicketActionsMenu', () => {
  it('is disabled with nothing to offer, rather than hidden', () => {
    renderApp(<TicketActionsMenu items={[]} />);

    expect(screen.getByRole('button', { name: 'More actions' })).toBeDisabled();
  });

  it('runs the chosen item and closes', async () => {
    const onSelect = vi.fn();
    const { user } = renderApp(
      <TicketActionsMenu
        items={[
          { key: 'merge', label: 'Merge', icon: GitMerge, onSelect: vi.fn() },
          {
            key: 'spam',
            label: 'Mark as spam',
            icon: ShieldAlert,
            tone: 'danger',
            separatorBefore: true,
            onSelect,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Merge',
      'Mark as spam',
    ]);
    expect(screen.getAllByRole('separator')).toHaveLength(1);

    await user.click(screen.getByRole('menuitem', { name: 'Mark as spam' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('draws no separator above the first item', async () => {
    const { user } = renderApp(
      <TicketActionsMenu
        items={[
          {
            key: 'spam',
            label: 'Mark as spam',
            icon: ShieldAlert,
            separatorBefore: true,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));

    expect(screen.queryByRole('separator')).toBeNull();
  });
});
