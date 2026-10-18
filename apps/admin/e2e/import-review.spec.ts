import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

test.use({ reducedMotion: 'reduce' });

test('reviews file availability and warnings before starting a quiet import', async ({
  page,
  appLocale: locale,
}) => {
  test.setTimeout(60000);
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();
  await page.getByRole('tab', { name: t('brand:tabs.import') }).click();
  await page.getByRole('button', { name: /Zoho Desk/ }).click();
  const progress = page.getByRole('navigation', { name: t('imports:wizard.label') });
  await expect(progress.locator('[aria-current="step"]')).toContainText(
    t('imports:wizard.connect'),
  );
  await page.getByLabel(t('imports:connection.zoho.orgId')).fill('90071992547409931234');
  await page.getByLabel(t('imports:connection.zoho.clientId')).fill('synthetic-client');
  await page.getByLabel(t('imports:connection.zoho.clientSecret')).fill('synthetic-secret');
  await page.getByLabel(t('imports:connection.zoho.refreshToken')).fill('synthetic-refresh');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await expect(progress.locator('[aria-current="step"]')).toContainText(t('imports:wizard.scope'));
  await page.getByRole('button', { name: t('imports:scope.extract') }).click();
  await expect(progress.locator('[aria-current="step"]')).toContainText(t('imports:wizard.map'));
  await page.getByRole('button', { name: t('imports:dryRun.rerun') }).click();
  await expect(page.getByText(t('imports:dryRun.fileStates.not_checked')).first()).toBeVisible();
  await expect(page.getByText(t('imports:dryRun.fileStates.available')).first()).toBeVisible();
  await expect(page.getByText(t('imports:dryRun.fileStates.unavailable')).first()).toBeVisible();
  const start = page.getByRole('button', { name: t('imports:dryRun.start') });
  await expect(start).toBeDisabled();
  await expect(
    progress.getByRole('link', { name: t('imports:wizard.map'), exact: true }),
  ).toHaveAttribute('href', '#import-mappings-heading');
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole('checkbox', { name: t('imports:dryRun.acknowledge') }).check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText(t('imports:status.completed'), { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(progress.locator('[aria-current="step"]')).toHaveCount(0);
  const clocks = page.getByRole('region', { name: t('imports:sla.title'), exact: true });
  await expect(clocks.getByRole('status')).toHaveCount(0);
  const activate = clocks.getByRole('button', {
    name: t('imports:sla.start', { count: 400 }),
    exact: true,
  });
  await activate.click();
  const confirmation = page.getByRole('dialog', { name: t('imports:sla.title') });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: t('common:actions.cancel') }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(clocks.getByRole('status')).toHaveCount(0);
  await activate.click();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await confirmation
    .getByRole('button', { name: t('imports:sla.start', { count: 400 }), exact: true })
    .click();
  await expect(confirmation).not.toBeVisible();
  await expect(clocks.getByText(t('imports:sla.status.completed'), { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect(clocks.getByRole('button')).toBeDisabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
});
