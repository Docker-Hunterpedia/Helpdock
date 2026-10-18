import { createI18n } from '@helpdock/i18n';
import { screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { MockImportsApi } from '../../../imports/mock-api.js';
import {
  mockContactPreview,
  mockDryRunReport,
  mockTicketPreview,
} from '../../../imports/mock-data.js';
import { renderApp } from '../../../test/render.js';
import { ImportDryRun } from './import-dry-run.js';

async function reviewedRun() {
  const run = await new MockImportsApi().create('0193b000-0000-7000-8000-000000000901', {
    source: 'zohodesk',
    mode: 'full',
  });
  return { ...run, status: 'awaiting_mapping' as const, hasDryRun: true };
}

it.each(['en', 'ar'] as const)(
  'binds warning acknowledgment to the exact reviewed report in %s',
  async (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
    const run = await reviewedRun();
    const start = vi.fn();
    function Review() {
      const [report, setReport] = useState(mockDryRunReport(true, false));
      return (
        <>
          <button
            type="button"
            onClick={() => setReport({ ...report, reviewToken: 'b'.repeat(64) })}
          >
            Replace review
          </button>
          <ImportDryRun
            run={run}
            report={report}
            previews={[mockTicketPreview()]}
            contacts={[mockContactPreview()]}
            busy={false}
            failed={false}
            onStart={start}
            onRevalidate={() => {}}
          />
        </>
      );
    }
    const { user } = renderApp(<Review />);
    const submit = screen.getByRole('button', { name: t('dryRun.start') });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: t('dryRun.acknowledge') }));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(start).toHaveBeenCalledWith({ reviewToken: 'a'.repeat(64), acknowledgeWarnings: true });
    await user.click(screen.getByRole('button', { name: 'Replace review' }));
    expect(submit).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: t('dryRun.acknowledge') })).not.toBeChecked();
  },
);

it.each([
  ['en', 'blocked'],
  ['ar', 'blocked'],
  ['en', 'invalidated'],
  ['ar', 'invalidated'],
  ['en', 'checking'],
  ['ar', 'checking'],
  ['en', 'preview-error'],
  ['ar', 'preview-error'],
  ['en', 'report-error'],
  ['ar', 'report-error'],
] as const)('refuses to start a %s import with %s', async (locale, scenario) => {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  const t = createI18n({ lng: locale }).getFixedT(locale, 'imports');
  const report = mockDryRunReport(true, scenario === 'blocked');
  report.warnings = 0;
  report.issues = report.issues.filter((issue) => issue.level === 'error');
  if (scenario === 'invalidated') {
    report.phase = 'invalidated';
    report.complete = false;
    report.reviewToken = null;
  }
  renderApp(
    <ImportDryRun
      run={await reviewedRun()}
      report={scenario === 'checking' ? undefined : report}
      previews={[mockTicketPreview()]}
      contacts={[mockContactPreview()]}
      busy={false}
      failed={scenario === 'report-error'}
      previewError={scenario === 'preview-error'}
      onStart={vi.fn()}
      onRevalidate={() => {}}
    />,
  );
  expect(screen.getByRole('button', { name: t('dryRun.start') })).toBeDisabled();
  const reason =
    scenario === 'blocked'
      ? t('dryRun.errors', { count: 1 })
      : scenario === 'invalidated'
        ? t('dryRun.stale')
        : scenario === 'preview-error'
          ? t('dryRun.previewFailed')
          : scenario === 'report-error'
            ? t('dryRun.failed')
            : t('dryRun.checking');
  expect(
    scenario === 'checking'
      ? screen.getByRole('status', { name: reason })
      : screen.getByText(reason),
  ).toBeVisible();
});
