import { createI18n } from '@helpdock/i18n';
import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { ImportConnection } from './import-connection.js';

const brandId = '0193b000-0000-7000-8000-000000000901';

it.each(['en', 'ar'] as const)(
  'connects the selected Zoho region with exact organization identity and clears both secrets in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await api.create(brandId, { source: 'zohodesk', mode: 'full' });
    const connect = vi.spyOn(api, 'connect');
    const onConnected = vi.fn();
    const { user } = renderApp(<ImportConnection run={run} onConnected={onConnected} />, {
      importsApi: api,
    });
    await user.click(screen.getByRole('combobox', { name: t('connection.zoho.region') }));
    await user.click(screen.getByRole('option', { name: t('connection.zoho.regions.eu') }));
    const credentials = {
      orgId: '90071992547409931234',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-client-secret',
      refreshToken: 'synthetic-refresh-token',
    };
    for (const field of ['orgId', 'clientId', 'clientSecret', 'refreshToken'] as const) {
      const input = screen.getByLabelText(t(`connection.zoho.${field}`));
      expect(input).toHaveAttribute('dir', 'ltr');
      await user.type(input, credentials[field]);
    }
    const secrets = (['clientSecret', 'refreshToken'] as const).map((field) =>
      screen.getByLabelText(t(`connection.zoho.${field}`)),
    );
    for (const input of secrets) expect(input).toHaveAttribute('type', 'password');
    expect(screen.getByText(t('connection.zoho.caption'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t('connection.test') }));
    await waitFor(() =>
      expect(onConnected).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'connecting', sourceAccount: `eu:${credentials.orgId}` }),
      ),
    );
    expect(connect).toHaveBeenCalledWith(brandId, run.id, {
      credentials: { region: 'eu', ...credentials },
      downloadHosts: [],
    });
    for (const input of secrets) expect(input).toHaveValue('');
    expect(screen.getByLabelText(t('connection.zoho.orgId'))).toHaveValue(credentials.orgId);
  },
);

it.each(['en', 'ar'] as const)(
  'rejects malformed Zoho identity before connecting and shows refused credentials safely in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi('credentials-refused');
    const run = await api.create(brandId, { source: 'zohodesk', mode: 'full' });
    const connect = vi.spyOn(api, 'connect');
    const onConnected = vi.fn();
    const { user } = renderApp(<ImportConnection run={run} onConnected={onConnected} />, {
      importsApi: api,
    });
    await user.type(screen.getByLabelText(t('connection.zoho.orgId')), 'not-an-id');
    await user.type(screen.getByLabelText(t('connection.zoho.clientId')), 'synthetic-client');
    await user.type(screen.getByLabelText(t('connection.zoho.clientSecret')), 'synthetic-secret');
    await user.type(screen.getByLabelText(t('connection.zoho.refreshToken')), 'synthetic-refresh');
    await user.click(screen.getByRole('button', { name: t('connection.test') }));
    expect(await screen.findByText(t('connection.invalid'))).toBeVisible();
    expect(connect).not.toHaveBeenCalled();
    const org = screen.getByLabelText(t('connection.zoho.orgId'));
    await user.clear(org);
    await user.type(org, '600000000001');
    await user.click(screen.getByRole('button', { name: t('connection.test') }));
    expect(await screen.findByText(t('connection.failed'))).toBeVisible();
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.queryByText('synthetic-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('synthetic-refresh')).not.toBeInTheDocument();
    expect(screen.getByLabelText(t('connection.zoho.clientSecret'))).toHaveValue(
      'synthetic-secret',
    );
  },
);

it.each(['en', 'ar'] as const)(
  'tests the chosen Freshdesk satisfaction API and clears its saved secret in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi();
    const run = await api.create(brandId, { source: 'freshdesk', mode: 'full' });
    const connect = vi.spyOn(api, 'connect');
    const onConnected = vi.fn();
    const { user } = renderApp(<ImportConnection run={run} onConnected={onConnected} />, {
      importsApi: api,
    });
    expect(screen.queryByLabelText(t('connection.email'))).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(t('connection.freshdeskDomain')), 'example');
    const secret = screen.getByLabelText(t('connection.freshdeskKey'));
    expect(secret).toHaveAttribute('type', 'password');
    await user.type(secret, 'synthetic-test-key');
    await user.click(screen.getByRole('combobox', { name: t('connection.csatApi') }));
    await user.click(screen.getByRole('option', { name: t('connection.csatLegacy') }));
    await user.click(screen.getByRole('button', { name: t('connection.test') }));
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(brandId, run.id, {
        credentials: { domain: 'example', apiKey: 'synthetic-test-key', csatApi: 'legacy' },
        downloadHosts: [],
      }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(secret).toHaveValue('');
  },
);

it.each(['en', 'ar'] as const)(
  'keeps connection failures visible without displaying the entered secret in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const api = new MockImportsApi('credentials-refused');
    const run = await api.create(brandId, { source: 'freshdesk', mode: 'full' });
    const onConnected = vi.fn();
    const { user } = renderApp(<ImportConnection run={run} onConnected={onConnected} />, {
      importsApi: api,
    });
    await user.type(screen.getByLabelText(t('connection.freshdeskDomain')), 'example');
    await user.type(screen.getByLabelText(t('connection.freshdeskKey')), 'synthetic-test-key');
    await user.click(screen.getByRole('button', { name: t('connection.test') }));
    await screen.findByText(t('connection.failed'));
    expect(onConnected).not.toHaveBeenCalled();
    expect(screen.queryByText('synthetic-test-key')).not.toBeInTheDocument();
  },
);
