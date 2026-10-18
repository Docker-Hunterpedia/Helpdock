import { createI18n } from '@helpdock/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { SessionProvider } from '../../../auth/session.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { signedInMockApis } from '../../../test/signed-in.js';
import { ImportRunPage } from './import-run-page.js';

it.each(['en', 'ar'] as const)(
  'keeps pause and cancel available after a failed poll and supports pause, resume and cancel in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const session = await (await signedInMockApis()).auth.me();
    if (!session) throw new Error('Missing session');
    class InterruptedApi extends MockImportsApi {
      pollsSeen = 0;
      override async run(brandId: string, runId: string) {
        this.pollsSeen++;
        if (this.pollsSeen === 2) throw new Error('Temporary poll failure');
        const row = this.rows.get(runId);
        if (!row || row.brandId !== brandId) throw new Error('Missing run');
        return structuredClone(row);
      }
    }
    const api = new InterruptedApi();
    const run = await api.create(session.currentBrandId, { source: 'zendesk', mode: 'full' });
    api.rows.set(run.id, { ...run, status: 'loading' });
    const { user } = renderApp(
      <SessionProvider session={session}>
        <ImportRunPage runId={run.id} />
      </SessionProvider>,
      { importsApi: api },
    );
    expect(await screen.findByRole('button', { name: t('run.pause') })).toBeEnabled();
    await waitFor(() => expect(api.pollsSeen).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    expect(screen.getByRole('button', { name: t('run.pause') })).toBeEnabled();
    expect(screen.getByRole('button', { name: t('run.cancel') })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: t('run.pause') }));
    await user.click(await screen.findByRole('button', { name: t('run.resume') }));
    expect(await screen.findByRole('button', { name: t('run.pause') })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: t('run.cancel') }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: t('run.cancel') }));
    expect(await screen.findByText(t('status.cancelled'), { exact: true })).toBeVisible();
    expect((await api.run(run.brandId, run.id)).hasCredentials).toBe(false);
  },
);
