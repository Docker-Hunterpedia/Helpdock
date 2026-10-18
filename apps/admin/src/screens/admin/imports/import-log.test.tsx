import { createI18n } from '@helpdock/i18n';
import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { ImportLog } from './import-log.js';

it.each(['en', 'ar'] as const)(
  'recovers a failed log request and filters the visible history in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await api.create('0193b000-0000-7000-8000-000000000901', {
      source: 'zendesk',
      mode: 'full',
    });
    vi.spyOn(api, 'log').mockRejectedValueOnce(new Error('Temporary log failure'));
    const { user } = renderApp(<ImportLog run={run} />, { importsApi: api });
    await user.click(await screen.findByRole('button', { name: t('retry') }));
    expect(await screen.findByText(t('log.messages.created'))).toBeVisible();
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: t('log.levels.error') }));
    expect(await screen.findByText(t('log.empty'))).toBeVisible();
    expect(screen.queryByText(t('log.messages.created'))).not.toBeInTheDocument();
  },
);
