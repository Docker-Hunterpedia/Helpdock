import { createI18n } from '@helpdock/i18n';
import type { ImportRunView } from '@helpdock/schemas';
import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import { renderApp } from '../../../test/render.js';
import { ImportWizardProgress, importWizardStep } from './import-wizard-progress.js';

it.each([
  [{ status: 'draft' }, 1],
  [{ status: 'connecting', hasCredentials: true }, 2],
  [{ status: 'extracting' }, 3],
  [{ status: 'awaiting_mapping', hasDryRun: false }, 4],
  [{ status: 'awaiting_mapping', hasDryRun: true }, 5],
  [{ status: 'dry_run' }, 5],
  [{ status: 'paused', pausedFrom: 'loading' }, 6],
  [{ status: 'completed' }, 6],
] satisfies [Partial<ImportRunView>, number][])(
  'keeps wizard progress aligned with the durable phase %j',
  async (patch, expected) => {
    const run = await new MockImportsApi().create('0193b000-0000-7000-8000-000000000901', {
      source: 'zohodesk',
      mode: 'full',
    });
    expect(importWizardStep({ ...run, ...patch })).toBe(expected);
  },
);

it.each(['en', 'ar'] as const)(
  'offers visible review links and disables navigation while busy in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const run = await new MockImportsApi().create('0193b000-0000-7000-8000-000000000901', {
      source: 'zohodesk',
      mode: 'full',
    });
    run.status = 'awaiting_mapping';
    run.hasDryRun = true;
    const rendered = renderApp(<ImportWizardProgress run={run} busy={false} />);
    const nav = screen.getByRole('navigation', { name: t('wizard.label') });
    expect(within(nav).getByRole('link', { name: t('wizard.map') })).toHaveAttribute(
      'href',
      '#import-mappings-heading',
    );
    expect(within(nav).getByRole('link', { name: t('wizard.dryRun') })).toHaveAttribute(
      'href',
      '#import-dry-run-heading',
    );
    expect(within(nav).queryByRole('link', { name: t('wizard.scope') })).not.toBeInTheDocument();
    expect(nav.querySelector('[aria-current="step"]')).toHaveTextContent(t('wizard.dryRun'));
    rendered.unmount();
    renderApp(<ImportWizardProgress run={run} busy />);
    expect(
      within(screen.getByRole('navigation', { name: t('wizard.label') })).queryAllByRole('link'),
    ).toHaveLength(0);
  },
);
