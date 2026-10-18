import { createI18n } from '@helpdock/i18n';
import { importFileViewSchema } from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { ImportInventoryMapper } from './import-inventory-mapper.js';

const brandId = '0193b000-0000-7000-8000-000000000901';
const file = importFileViewSchema.parse({
  id: '0193b000-0000-7000-8000-000000000902',
  runId: '0193b000-0000-7000-8000-000000000903',
  revision: '0193b000-0000-7000-8000-000000000904',
  fileName: 'archive.csv',
  format: 'csv',
  entity: 'ticket',
  size: 40,
  status: 'ready',
  headers: ['Ticket ID', 'Subject'],
  sampleRows: [{ cells: ['9001', 'Original question'], line: 2, truncated: false }],
  mapping: null,
  validation: null,
  inventoryMapping: { idColumn: null, location: 'archived' },
  inventoryValidation: null,
  recordCount: null,
  error: null,
});

it.each(['en', 'ar'] as const)(
  'requires a chosen ID column, previews its original value and saves the explicit location in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const api = new MockImportsApi();
    const save = vi.spyOn(api, 'mapInventory').mockResolvedValue({
      ...file,
      inventoryMapping: { idColumn: 'Ticket ID', location: 'archived' },
    });
    const dirty = vi.fn();
    const busy = vi.fn();
    const { user } = renderApp(
      <ImportInventoryMapper
        brandId={brandId}
        runId={file.runId}
        file={file}
        disabled={false}
        onDirty={dirty}
        onBusy={busy}
      />,
      { importsApi: api },
    );
    const button = screen.getByRole('button', {
      name: locale === 'en' ? 'Save ID mapping' : 'حفظ ربط المعرّفات',
    });
    expect(button).toBeDisabled();
    await user.click(
      screen.getByRole('combobox', {
        name: locale === 'en' ? 'Source ticket ID column' : 'عمود معرّف التذكرة في المصدر',
      }),
    );
    await user.click(screen.getByRole('option', { name: 'Ticket ID' }));
    expect(screen.getByText('9001')).toBeInTheDocument();
    expect(screen.queryByText('Original question')).not.toBeInTheDocument();
    expect(dirty).toHaveBeenCalledWith(true);
    await user.click(button);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(brandId, file.runId, file.id, {
        idColumn: 'Ticket ID',
        location: 'archived',
      }),
    );
    await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
    expect(busy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  },
);

it.each(['en', 'ar'] as const)(
  'keeps an unsaved inventory choice after a failed save in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const api = new MockImportsApi();
    vi.spyOn(api, 'mapInventory').mockRejectedValue(new Error('synthetic write refusal'));
    const dirty = vi.fn();
    const { user } = renderApp(
      <ImportInventoryMapper
        brandId={brandId}
        runId={file.runId}
        file={file}
        disabled={false}
        onDirty={dirty}
        onBusy={() => {}}
      />,
      { importsApi: api },
    );
    await user.click(
      screen.getByRole('combobox', {
        name: locale === 'en' ? 'Source ticket ID column' : 'عمود معرّف التذكرة في المصدر',
      }),
    );
    await user.click(screen.getByRole('option', { name: 'Ticket ID' }));
    await user.click(
      screen.getByRole('button', {
        name: locale === 'en' ? 'Save ID mapping' : 'حفظ ربط المعرّفات',
      }),
    );
    await waitFor(() => expect(screen.getByText('9001')).toBeInTheDocument());
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    await waitFor(() => expect(screen.getByText(t('columns.saveFailed'))).toBeInTheDocument());
    expect(dirty).not.toHaveBeenCalledWith(false);
  },
);
