import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { EMPTY_FILTERS } from '../../tickets/views.js';
import { SortMenu } from './sort-menu.tsx';

describe('ticket sort menu', () => {
  it('selects SLA urgency without changing filters and closes the menu', async () => {
    const onChange = vi.fn();
    const filters = { ...EMPTY_FILTERS, q: 'refund', priority: ['urgent'] as const };
    const { user } = renderApp(<SortMenu filters={filters} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    await user.click(screen.getByRole('menuitemradio', { name: /SLA due/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      ...filters,
      sort: 'slaDue',
      direction: 'asc',
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('cancels with Escape without changing the order', async () => {
    const onChange = vi.fn();
    const { user } = renderApp(<SortMenu filters={EMPTY_FILTERS} onChange={onChange} />);
    const button = screen.getByRole('button', { name: 'Sort' });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(onChange).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });
});
