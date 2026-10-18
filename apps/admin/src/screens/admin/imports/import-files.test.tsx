import { createI18n } from '@helpdock/i18n';
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import type { ImportFileView } from '../../../imports/api.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { ImportFiles } from './import-files.js';

const brandId = '0193b000-0000-7000-8000-000000000901';

it.each(['en', 'ar'] as const)(
  'loads previews only for the chosen inventory file and gates extraction on validation in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await api.create(brandId, { source: 'freshdesk', mode: 'full' });
    await api.connect(brandId, run.id, {
      credentials: { domain: 'example', apiKey: 'synthetic-test-key' },
      downloadHosts: [],
    });
    const files: ImportFileView[] = [];
    for (const fileName of ['active.csv', 'archive.csv']) {
      const allocation = await api.uploadFile(brandId, run.id, {
        format: 'csv',
        entity: 'ticket',
        size: 50,
        fileName,
        inventoryMapping: { idColumn: null, location: 'auto' },
      });
      files.push(await api.confirmFile(brandId, run.id, allocation.file.id));
    }
    const detail = vi.spyOn(api, 'file');
    const ready = vi.fn();
    const { user } = renderApp(
      <ImportFiles brandId={brandId} runId={run.id} inventory onBusy={vi.fn()} onReady={ready} />,
      { importsApi: api },
    );
    await screen.findByText('active.csv');
    expect(detail).not.toHaveBeenCalled();
    expect(ready).toHaveBeenLastCalledWith(false);
    await user.click(screen.getAllByRole('button', { name: t('inventory.mappingTitle') })[0]!);
    await screen.findByRole('combobox', { name: t('inventory.idColumn') });
    await waitFor(() => expect(detail).toHaveBeenCalledWith(brandId, run.id, files[0]!.id));
    expect(detail).not.toHaveBeenCalledWith(brandId, run.id, files[1]!.id);
    await user.click(screen.getByRole('combobox', { name: t('inventory.idColumn') }));
    await user.click(screen.getByRole('option', { name: 'Ticket ID' }));
    await user.click(screen.getByRole('button', { name: t('inventory.save') }));
    await screen.findByText(t('inventory.validated', { records: '1', duplicates: '0' }));
    // A validated file cannot hide another unmapped file in the same run.
    expect(ready).toHaveBeenLastCalledWith(false);
  },
);
