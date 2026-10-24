import type { CustomFieldDef } from '@helpdock/schemas';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../app/preferences.js';
import { renderApp } from '../../test/render.js';
import { CloseGateDialog } from './close-gate-dialog.tsx';

const def = (over: Partial<CustomFieldDef> & Pick<CustomFieldDef, 'key' | 'label'>) =>
  ({
    id: `id-${over.key}`,
    target: 'ticket',
    labelAr: null,
    type: 'text',
    options: [],
    required: false,
    requiredToClose: true,
    agentVisible: true,
    sortOrder: 0,
    ...over,
  }) satisfies CustomFieldDef;

const FIELDS = [
  def({ key: 'order_id', label: 'Order id', labelAr: 'رقم الطلب' }),
  def({ key: 'root_cause', label: 'Root cause', type: 'select', options: ['Bug', 'Billing'] }),
];

const renderGate = (props: { stillEmpty?: string | null } = {}) => {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const rendered = renderApp(
    <CloseGateDialog
      open
      reference="HD-1042"
      fields={FIELDS}
      stored={{}}
      busy={false}
      stillEmpty={props.stillEmpty ?? null}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );

  return { ...rendered, onSubmit, onClose };
};

afterEach(() => {
  localStorage.clear();
});

describe('CloseGateDialog (M14-17)', () => {
  it('names the ticket and marks each field as required to close', () => {
    renderGate();

    expect(screen.getByRole('dialog', { name: 'Fill in before closing' })).toBeInTheDocument();
    expect(screen.getByText('HD-1042 needs these before it can be closed:')).toBeInTheDocument();
    expect(screen.getAllByText('Required to close')).toHaveLength(2);
    // The marker describes the control, so a reader hears why it is asked for.
    expect(screen.getByRole('textbox', { name: 'Order id' })).toHaveAccessibleDescription(
      'Required to close',
    );
  });

  it('sends what was typed and nothing for a field left empty', async () => {
    const { user, onSubmit } = renderGate();

    await user.type(screen.getByRole('textbox', { name: 'Order id' }), ' A-77 ');
    await user.click(screen.getByRole('button', { name: 'Save and close' }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ order_id: 'A-77' });
  });

  it('closes nothing on Cancel', async () => {
    const { user, onSubmit, onClose } = renderGate();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('says what is still empty after the api refuses again', () => {
    renderGate({ stillEmpty: 'Root cause' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Fill in the required fields before closing: Root cause.',
    );
  });

  it('reads in Arabic, with the Arabic label', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderGate();

    expect(screen.getByRole('dialog', { name: 'املأ الحقول قبل الإغلاق' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'رقم الطلب' })).toHaveAccessibleDescription(
      'مطلوب للإغلاق',
    );
    expect(screen.getByRole('button', { name: 'احفظ وأغلق' })).toBeInTheDocument();
  });
});
