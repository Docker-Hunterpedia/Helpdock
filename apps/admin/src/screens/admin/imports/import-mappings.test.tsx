import { createI18n } from '@helpdock/i18n';
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { MockStaffApi } from '../../../staff/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { MockTicketingApi } from '../../../ticketing/mock-api.js';
import { ImportMappings } from './import-mappings.js';

it.each(['en', 'ar'] as const)(
  'keeps failed mapping edits for retry and discards only unsaved changes in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await api.create('0193b000-0000-7000-8000-000000000901', {
      source: 'zendesk',
      mode: 'full',
    });
    api.rows.set(run.id, { ...run, status: 'awaiting_mapping' });
    // The API is the component boundary; model a transient failed save, not a failed child hook.
    vi.spyOn(api, 'updateMappings').mockRejectedValueOnce(new Error('temporary network failure'));
    const { user } = renderApp(
      <ImportMappings
        brandId={run.brandId}
        runId={run.id}
        disabled={false}
        onDirty={() => {}}
        onSaved={async () => {}}
      />,
      { importsApi: api },
    );
    await user.click(screen.getByRole('tab', { name: t('mapping.kinds.priority') }));
    const picker = await screen.findByRole('combobox', { name: t('mapping.destination') });
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: 'high' }));
    expect(screen.getByRole('tab', { name: t('mapping.kinds.status') })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: t('mapping.save') }));
    expect(await screen.findByText(t('mapping.saveFailed'))).toBeVisible();
    expect(picker).toHaveValue('high');
    await user.click(screen.getByRole('button', { name: t('mapping.save') }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: t('mapping.kinds.status') })).toBeEnabled(),
    );
    expect(
      (await api.mappingValues(run.brandId, run.id, { kind: 'priority', limit: 50 })).values[0]
        ?.confirmed,
    ).toMatchObject({ target: { priority: 'high' } });
    await user.click(screen.getByRole('combobox', { name: t('mapping.destination') }));
    await user.click(await screen.findByRole('option', { name: 'low' }));
    await user.click(screen.getByRole('button', { name: t('mapping.discard') }));
    expect(screen.getByRole('combobox', { name: t('mapping.destination') })).toHaveValue('high');
  },
);

it.each([
  ['en', 'Closed'],
  ['ar', 'مغلقة'],
] as const)(
  'names a confirmed destination on a freshly loaded closed row in %s',
  async (locale, name) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const ticketing = new MockTicketingApi();
    const api = new MockImportsApi('happy', { ticketing, staff: new MockStaffApi() });
    const run = await api.create('0193b000-0000-7000-8000-000000000902', {
      source: 'zendesk',
      mode: 'full',
    });
    api.rows.set(run.id, { ...run, status: 'awaiting_mapping' });
    const closed = (await ticketing.statuses(run.brandId)).statuses.find(
      (status) => status.name === 'Closed',
    );
    if (!closed) throw new Error('Missing seeded closed status');
    await api.updateMappings(run.brandId, run.id, {
      mappings: [{ kind: 'status', externalValue: 'closed', target: { statusId: closed.id } }],
    });
    const targets = vi.spyOn(api, 'mappingTargets');
    renderApp(
      <ImportMappings
        brandId={run.brandId}
        runId={run.id}
        disabled={false}
        onDirty={() => {}}
        onSaved={async () => {}}
      />,
      { importsApi: api },
    );
    const [closedRow] = await screen.findAllByRole('combobox', { name: t('mapping.destination') });
    expect(closedRow).toHaveValue(name);
    expect(targets).not.toHaveBeenCalled();
  },
);
