import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.js';
import type { PreviewSummary } from '../../../tickets/bulk.js';
import { BulkPreviewDialog } from './bulk-preview-dialog.tsx';

const summary: PreviewSummary = {
  total: 3,
  changing: ['c'],
  blockers: [
    {
      ticketId: 'a',
      reason: {
        kind: 'refused',
        code: 'fields-required-to-close',
        missing: [{ key: 'order_id', label: 'Order id', labelAr: 'رقم الطلب' }],
      },
    },
    {
      ticketId: 'b',
      reason: {
        kind: 'refused',
        code: 'fields-required-to-close',
        missing: [
          { key: 'order_id', label: 'Order id', labelAr: null },
          { key: 'root_cause', label: 'Root cause', labelAr: 'السبب الجذري' },
        ],
      },
    },
  ],
};

const renderDialog = (override: PreviewSummary = summary) =>
  renderApp(
    <BulkPreviewDialog
      choice={{ kind: 'close' }}
      summary={override}
      refreshed={false}
      applying={false}
      referenceOf={(id) => `HD-${id}`}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );

afterEach(() => {
  localStorage.clear();
});

describe('BulkPreviewDialog, tickets a required-to-close field stopped (M14-17)', () => {
  it('names the field beside the ticket, in English', () => {
    renderDialog();

    const rows = within(
      screen.getByRole('list', { name: 'Tickets that cannot change' }),
    ).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('HD-a');
    expect(rows[0]).toHaveTextContent('“Order id” must be filled in before it can be closed.');
    expect(rows[1]).toHaveTextContent(
      '“Order id” and “Root cause” must be filled in before it can be closed.',
    );
  });

  it('names it in Arabic, with the Arabic label where there is one', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    renderDialog();

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('يجب ملء «رقم الطلب» قبل الإغلاق.');
    expect(rows[1]).toHaveTextContent('«Order id» و«السبب الجذري»');
  });

  it('falls back to the code’s own sentence when the refusal carries no list', () => {
    renderDialog({
      total: 1,
      changing: [],
      blockers: [{ ticketId: 'a', reason: { kind: 'refused', code: 'fields-required-to-close' } }],
    });

    expect(screen.getByRole('listitem')).toHaveTextContent(
      'Required fields must be filled in before it can be closed.',
    );
  });
});
