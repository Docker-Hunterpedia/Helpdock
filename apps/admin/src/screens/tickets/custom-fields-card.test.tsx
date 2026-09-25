import type { CustomFieldDef, CustomFieldType } from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../test/render.tsx';
import { CustomFieldsCard } from './custom-fields-card.tsx';

/**
 * The editors of the details panel's custom fields (M1-15), one per type: what
 * each sends, and when. The ticket screen's own tests cover the round trip
 * through the fixture; these cover the controls a seeded brand does not have.
 */

const def = (
  type: CustomFieldType,
  label: string,
  overrides: Partial<CustomFieldDef> = {},
): CustomFieldDef => ({
  id: `id-${type}`,
  target: 'ticket',
  key: type,
  label,
  labelAr: null,
  type,
  options: type === 'select' || type === 'multi_select' ? ['DHL', 'UPS'] : [],
  required: false,
  agentVisible: true,
  sortOrder: 0,
  ...overrides,
});

const FIELDS = [
  def('number', 'Amount'),
  def('select', 'Carrier'),
  def('multi_select', 'Carriers'),
  def('checkbox', 'Gift'),
];

const renderCard = (onSave = vi.fn().mockResolvedValue(undefined), values = {}) => {
  const rendered = renderApp(
    <CustomFieldsCard fields={FIELDS} values={values} canWrite onSave={onSave} />,
  );

  return { ...rendered, onSave };
};

describe('CustomFieldsCard', () => {
  it('sends a number as a number, once, on blur', async () => {
    const { user, onSave } = renderCard(undefined, { number: 3 });

    await user.clear(screen.getByRole('spinbutton', { name: 'Amount' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Amount' }), '12.5');
    expect(onSave).not.toHaveBeenCalled();
    await user.tab();

    expect(onSave).toHaveBeenCalledExactlyOnceWith('number', 12.5);
  });

  it('sends nothing for a blur that changed nothing', async () => {
    const { user, onSave } = renderCard(undefined, { number: 3 });

    await user.click(screen.getByRole('spinbutton', { name: 'Amount' }));
    await user.tab();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves a select as soon as it is chosen, and clears it with the empty option', async () => {
    const { user, onSave } = renderCard(undefined, { select: 'UPS' });

    await user.click(screen.getByRole('combobox', { name: 'Carrier' }));
    await user.click(await screen.findByRole('option', { name: 'DHL' }));
    expect(onSave).toHaveBeenLastCalledWith('select', 'DHL');

    await user.click(screen.getByRole('combobox', { name: 'Carrier' }));
    await user.click(await screen.findByRole('option', { name: '—' }));
    expect(onSave).toHaveBeenLastCalledWith('select', null);
  });

  it('saves a multi-select as a list of the options chosen', async () => {
    const { user, onSave } = renderCard();

    await user.click(screen.getByRole('combobox', { name: 'Carriers' }));
    await user.click(await screen.findByRole('option', { name: 'UPS' }));

    expect(onSave).toHaveBeenLastCalledWith('multi_select', ['UPS']);
  });

  it('saves a tick as a boolean', async () => {
    const { user, onSave } = renderCard();

    await user.click(screen.getByRole('checkbox', { name: 'Gift' }));

    expect(onSave).toHaveBeenLastCalledWith('checkbox', true);
  });

  it('shows the refusal for the field’s type and unticks the box again', async () => {
    const { user } = renderCard(vi.fn().mockRejectedValue(new Error('400')));
    const box = screen.getByRole('checkbox', { name: 'Gift' });

    await user.click(box);

    expect(await screen.findByRole('alert')).toHaveTextContent('That value was not saved.');
    await waitFor(() => {
      expect(box).not.toBeChecked();
    });
    expect(box).toHaveAccessibleDescription('That value was not saved.');
  });

  it('says so when the brand has no ticket fields', () => {
    renderApp(<CustomFieldsCard fields={[]} values={{}} canWrite onSave={vi.fn()} />);

    expect(screen.getByText('None')).toBeVisible();
  });
});
