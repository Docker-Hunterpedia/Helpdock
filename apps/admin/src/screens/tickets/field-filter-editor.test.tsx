import type { CustomFieldDef, TicketFieldFilter } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.tsx';
import { FieldFilterEditor } from './field-filter-editor.tsx';

const def = (key: string, type: CustomFieldDef['type'], extra: Partial<CustomFieldDef> = {}) => ({
  id: `id-${key}`,
  target: 'ticket' as const,
  key,
  label: key[0]?.toUpperCase() + key.slice(1),
  labelAr: null,
  type,
  options: type === 'select' ? ['Sev 1', 'Sev 2'] : [],
  required: false,
  agentVisible: true,
  pinned: false,
  sortOrder: 0,
  ...extra,
});

const FIELDS: CustomFieldDef[] = [
  def('severity', 'select', { labelAr: 'الخطورة' }),
  def('total', 'number'),
  def('vip', 'checkbox'),
  def('note', 'text'),
];

const render = (
  value: readonly TicketFieldFilter[] = [],
  props: { applyLabel?: string; disabled?: boolean } = {},
) => {
  const onChange = vi.fn();
  const rendered = renderApp(
    <FieldFilterEditor fields={FIELDS} value={value} onChange={onChange} {...props} />,
  );

  return { ...rendered, onChange };
};

const addFilter = async (user: ReturnType<typeof render>['user'], field: string) => {
  await user.click(screen.getByRole('button', { name: 'Add filter' }));
  await user.click(await screen.findByRole('menuitem', { name: field }));
};

describe('FieldFilterEditor', () => {
  it('offers only the fields not yet filtered', async () => {
    const { user } = render([{ key: 'vip', op: 'is', value: true }]);

    await user.click(screen.getByRole('button', { name: 'Add filter' }));

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Severity',
      'Total',
      'Note',
    ]);
  });

  it('says so when there is nothing yet, and disables Add when every field is used', () => {
    const { unmount } = render();
    expect(screen.getByText('No field filters yet.')).toBeInTheDocument();
    unmount();

    render(FIELDS.map((field) => ({ key: field.key, op: 'not_set' }) as TicketFieldFilter));
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeDisabled();
  });

  it('applies a select filter once an option is chosen, and not before', async () => {
    const { user, onChange } = render([], { applyLabel: 'Apply' });

    await addFilter(user, 'Severity');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('no value yet');

    await user.click(screen.getByRole('switch', { name: 'Sev 1' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([
      { key: 'severity', op: 'any_of', values: ['Sev 1'] },
    ]);
  });

  it('offers a number the operators a number has, and a range needs both ends in order', async () => {
    const { user, onChange } = render([], { applyLabel: 'Apply' });

    await addFilter(user, 'Total');
    const operator = screen.getByRole('combobox', { name: 'Total operator' });
    expect(
      within(operator)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['is between', 'is before', 'is after', 'is not set']);

    await user.type(screen.getByLabelText('Total from'), '20');
    await user.type(screen.getByLabelText('Total to'), '10');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Total to'));
    await user.type(screen.getByLabelText('Total to'), '30');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([
      { key: 'total', op: 'between', from: 20, to: 30 },
    ]);
  });

  it('applies "is not set" with no value to fill in, and a ticked box either way', async () => {
    const { user, onChange } = render([], { applyLabel: 'Apply' });

    await addFilter(user, 'Vip');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Vip value' }), 'Not ticked');
    await addFilter(user, 'Note');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Note operator' }), 'is not set');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith([
      { key: 'vip', op: 'is', value: false },
      { key: 'note', op: 'not_set' },
    ]);
  });

  it('removes a row and passes the rest on at once when it has no Apply (the view editor)', async () => {
    const { user, onChange } = render([
      { key: 'vip', op: 'is', value: true },
      { key: 'note', op: 'contains', value: 'stripe' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Remove the Vip filter' }));

    expect(onChange).toHaveBeenLastCalledWith([{ key: 'note', op: 'contains', value: 'stripe' }]);
  });

  it('follows the filters when something else changes them', async () => {
    function Harness(): ReactNode {
      const [value, setValue] = useState<readonly TicketFieldFilter[]>([
        { key: 'note', op: 'contains', value: 'stripe' },
      ]);

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setValue([{ key: 'vip', op: 'is', value: true }]);
            }}
          >
            Swap
          </button>
          <FieldFilterEditor fields={FIELDS} value={value} onChange={setValue} />
        </>
      );
    }
    const { user } = renderApp(<Harness />);
    expect(screen.getByLabelText('Note value')).toHaveValue('stripe');

    await user.click(screen.getByRole('button', { name: 'Swap' }));

    expect(screen.queryByRole('combobox', { name: 'Note operator' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Vip value' })).toHaveValue('yes');
  });

  it('names a field in Arabic while the desk is in Arabic', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    render([{ key: 'severity', op: 'not_set' }]);
    localStorage.removeItem(LOCALE_STORAGE_KEY);

    expect(screen.getByText('الخطورة')).toBeInTheDocument();
  });

  it('shows the filters of a view it may not change, locked', () => {
    render([{ key: 'vip', op: 'is', value: true }], { disabled: true });

    expect(screen.getByRole('combobox', { name: 'Vip operator' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove the Vip filter' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add filter' })).toBeDisabled();
  });
});
