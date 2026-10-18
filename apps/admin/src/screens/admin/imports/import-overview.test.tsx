import { createI18n } from '@helpdock/i18n';
import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { SessionProvider } from '../../../auth/session.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { signedInMockApis } from '../../../test/signed-in.js';
import { ImportOverview } from './import-overview.js';

it.each(['en', 'ar'] as const)(
  'recovers the import history after a failed request in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const session = await (await signedInMockApis()).auth.me();
    if (!session) throw new Error('Missing session');
    const api = new MockImportsApi();
    await api.create(session.currentBrandId, { source: 'zohodesk', mode: 'full' });
    vi.spyOn(api, 'runs').mockRejectedValueOnce(new Error('Temporary history failure'));
    const { user } = renderApp(
      <SessionProvider session={session}>
        <ImportOverview />
      </SessionProvider>,
      { importsApi: api },
    );
    await user.click(await screen.findByRole('button', { name: t('retry') }));
    expect(await screen.findByRole('table', { name: t('history.title') })).toBeVisible();
    expect(screen.queryByText(t('loadFailed'))).not.toBeInTheDocument();
  },
);
