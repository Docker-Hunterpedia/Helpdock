import { createI18n } from '@helpdock/i18n';
import type { ImportRunView } from '@helpdock/schemas';
import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { ImportScope } from './import-scope.js';

const brandId = '0193b000-0000-7000-8000-000000000901';

it.each(['en', 'ar'] as const)(
  'allows automatic Zoho extraction but requires reviewed files after opting into an inventory in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const draft = await api.create(brandId, { source: 'zohodesk', mode: 'full' });
    const { run } = await api.connect(brandId, draft.id, {
      credentials: {
        region: 'us',
        orgId: '600000000001',
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-secret',
        refreshToken: 'synthetic-refresh',
      },
      downloadHosts: [],
    });
    const scope = vi.spyOn(api, 'scope');
    const onExtracting = vi.fn();
    const { user } = renderApp(<ImportScope run={run} onExtracting={onExtracting} />, {
      importsApi: api,
    });
    const start = screen.getByRole('button', { name: t('scope.extract') });
    const fallback = screen.getByRole('checkbox', { name: t('inventory.useFallback') });
    expect(start).toBeEnabled();
    expect(
      screen.queryByRole('checkbox', { name: t('inventory.confirm') }),
    ).not.toBeInTheDocument();
    await user.click(fallback);
    expect(start).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: t('inventory.confirm') })).toBeDisabled();
    await user.click(fallback);
    expect(start).toBeEnabled();
    await user.click(start);
    await waitFor(() =>
      expect(onExtracting).toHaveBeenCalledWith(expect.objectContaining({ status: 'extracting' })),
    );
    expect(scope).toHaveBeenCalledWith(brandId, run.id, {
      entities: run.scope.entities,
      rebuildAllReports: false,
      useTicketInventory: false,
    });
  },
);

async function connectedRun(
  api: MockImportsApi,
  entities: ImportRunView['scope']['entities'] = ['ticket'],
) {
  const run = await api.create(brandId, { source: 'freshdesk', mode: 'full' });
  const connected = await api.connect(brandId, run.id, {
    credentials: { domain: 'example', apiKey: 'synthetic-test-key' },
    downloadHosts: [],
  });
  return { ...connected.run, scope: { ...connected.run.scope, entities } };
}

it.each(['en', 'ar'] as const)(
  'requires fresh confirmation after the inventory or its mode changes in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await connectedRun(api);
    const extract = vi.spyOn(api, 'extract');
    const scope = vi.spyOn(api, 'scope');
    const onExtracting = vi.fn();
    function Harness() {
      const [revision, setRevision] = useState('original');
      return (
        <>
          <ImportScope
            run={run}
            onExtracting={onExtracting}
            inventoryReady
            inventoryRevision={revision}
          />
          <button type="button" onClick={() => setRevision('changed-file')}>
            Replace inventory fixture
          </button>
        </>
      );
    }
    const { user } = renderApp(<Harness />, { importsApi: api });
    const start = screen.getByRole('button', { name: t('scope.extract') });
    const confirmation = screen.getByRole('checkbox', { name: t('inventory.confirm') });
    expect(start).toBeDisabled();
    await user.click(confirmation);
    expect(start).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Replace inventory fixture' }));
    await waitFor(() => expect(confirmation).not.toBeChecked());
    expect(start).toBeDisabled();
    await user.click(confirmation);
    await user.click(screen.getByRole('combobox', { name: t('inventory.mode') }));
    await user.click(screen.getByRole('option', { name: t('inventory.modes.complete') }));
    expect(confirmation).not.toBeChecked();
    expect(start).toBeDisabled();
    expect(extract).not.toHaveBeenCalled();
    await user.click(confirmation);
    await user.click(start);
    await waitFor(() =>
      expect(scope).toHaveBeenCalledWith(brandId, run.id, {
        entities: ['ticket'],
        rebuildAllReports: run.scope.rebuildAllReports,
        inventoryMode: 'complete',
        inventoryConfirmed: true,
      }),
    );
    await waitFor(() =>
      expect(onExtracting).toHaveBeenCalledWith(expect.objectContaining({ status: 'extracting' })),
    );
  },
);

it.each(['en', 'ar'] as const)(
  'allows a profiles-only scope without ticket inventories in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await connectedRun(api, ['contact', 'organization']);
    const scope = vi.spyOn(api, 'scope');
    const onExtracting = vi.fn();
    const { user } = renderApp(<ImportScope run={run} onExtracting={onExtracting} />, {
      importsApi: api,
    });
    expect(
      screen.queryByRole('checkbox', { name: t('inventory.confirm') }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('scope.extract') }));
    await waitFor(() =>
      expect(scope).toHaveBeenCalledWith(brandId, run.id, {
        entities: ['contact', 'organization'],
        rebuildAllReports: run.scope.rebuildAllReports,
      }),
    );
    await waitFor(() => expect(onExtracting).toHaveBeenCalled());
  },
);

it.each(['en', 'ar'] as const)(
  'does not extract after the server refuses a stale inventory in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await connectedRun(api);
    vi.spyOn(api, 'scope').mockRejectedValue(new Error('import.inventory-not-ready'));
    const extract = vi.spyOn(api, 'extract');
    const { user } = renderApp(
      <ImportScope run={run} onExtracting={vi.fn()} inventoryReady inventoryRevision="original" />,
      { importsApi: api },
    );
    await user.click(screen.getByRole('checkbox', { name: t('inventory.confirm') }));
    await user.click(screen.getByRole('button', { name: t('scope.extract') }));
    await screen.findByText(t('scope.failed'));
    expect(extract).not.toHaveBeenCalled();
  },
);
