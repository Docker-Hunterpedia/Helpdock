import type { CustomFieldDef } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.tsx';
import { EMPTY_FILTERS, type WorkspaceFilters } from '../../tickets/views.js';
import { useFilterSummary } from './filter-summary.js';

/**
 * How custom-field filters read in words (M14-16): in the chips under the list
 * header, in the "Saves" line of the save dialog and in the Views tab.
 */

const fields: CustomFieldDef[] = [
  {
    id: 'f1',
    target: 'ticket',
    key: 'severity',
    label: 'Severity',
    labelAr: 'الخطورة',
    type: 'select',
    options: ['Sev 1', 'Sev 2'],
    required: false,
    agentVisible: true,
    pinned: true,
    sortOrder: 0,
  },
];

const filters: WorkspaceFilters = {
  ...EMPTY_FILTERS,
  fieldFilter: [
    { key: 'severity', op: 'any_of', values: ['Sev 1', 'Sev 2'] },
    { key: 'vip', op: 'is', value: false },
    { key: 'total', op: 'between', from: 1, to: 9 },
    { key: 'note', op: 'contains', value: 'stripe' },
    { key: 'renewal', op: 'before', value: '2026-04-01' },
    { key: 'order_id', op: 'not_set' },
  ],
};

function Probe(): React.ReactNode {
  const summary = useFilterSummary({ statuses: [], departments: [], tags: [], staff: [], fields });

  return (
    <>
      <p data-testid="sentence">{summary.sentence(filters)}</p>
      <ul>
        {summary.chips(filters).map((chip) => (
          <li key={chip.key} data-without={chip.without.fieldFilter.length}>
            {chip.label}
          </li>
        ))}
      </ul>
    </>
  );
}

describe('field filters in words', () => {
  it('prints each operator, naming the field by its label and an unknown key by itself', () => {
    renderApp(<Probe />);

    expect(screen.getByTestId('sentence')).toHaveTextContent(
      'Severity is Sev 1 or Sev 2 · vip is not ticked · total between 1 and 9 · note contains "stripe" · renewal before 2026-04-01 · order_id is not set',
    );
  });

  it('makes one chip per filter, each removing only itself', () => {
    renderApp(<Probe />);

    const chips = screen.getAllByRole('listitem');
    expect(chips).toHaveLength(6);
    expect(chips.every((chip) => chip.getAttribute('data-without') === '5')).toBe(true);
  });

  it('names the field in Arabic while the desk is in Arabic', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderApp(<Probe />);
    localStorage.removeItem(LOCALE_STORAGE_KEY);

    expect(screen.getByTestId('sentence')).toHaveTextContent('الخطورة');
  });
});
