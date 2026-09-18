import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_EMAIL } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn, submitPassword } from './flows.js';
import { strings } from './strings.js';

/**
 * Transitions are off for this file: a menu caught mid-fade reads as low
 * contrast to axe, and DESIGN §4 says reduced motion drops every duration to
 * zero, so this is also the only place that state is exercised.
 */
test.use({ reducedMotion: 'reduce' });

/**
 * DESIGN §10 is checked against WCAG 2.1 A and AA, in both languages. The
 * result is reduced to one line per violation so a failure reads as a list of
 * rules rather than a page of JSON.
 */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

test.describe('accessibility', () => {
  test('sign in has no violations, with or without an error showing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/sign-in');
    expect(await violations(page)).toEqual([]);

    await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill('wrong horse');
    await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
    await page.getByRole('alert').waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the code screen has no violations, including its lock banner', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale);
    expect(await violations(page)).toEqual([]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByLabel(t('auth:totp.codeLabel')).fill('000000');
      await page.getByRole('button', { name: t('auth:totp.submit') }).click();
    }
    await expect(page.getByRole('alert')).toHaveText(t('auth:totp.locked'));

    expect(await violations(page)).toEqual([]);
  });

  test('the shell has no violations, with its menus open', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await signIn(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('admin:brandSwitcher.action') }).click();
    await page.getByRole('menu', { name: t('admin:brandSwitcher.action') }).waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
