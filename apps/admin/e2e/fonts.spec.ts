import { MOCK_USER } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { openSettingsArea, openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

// Exercise both caches and the reduced-motion theme composition, which must
// retain CssBaseline's font variables when it adds its global overrides.
for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test.describe(`fonts with motion ${reducedMotion} (#339)`, () => {
    test.use({ reducedMotion });
    test('uses Plex for body and ids and rebuilds the theme on language switch', async ({
      page,
      appLocale: locale,
    }) => {
      await signIn(page, locale);
      await openTicket(page, locale);
      const t = strings(locale);
      const reference = page
        .getByRole('region', { name: t('tickets:header.label') })
        .getByText('HD-1042', { exact: true });
      await expect(reference).toHaveCSS('font-family', /IBM Plex Mono/);
      await expect(page.locator('body')).toHaveCSS(
        'font-family',
        locale === 'ar' ? /IBM Plex Sans Arabic/ : /^"?IBM Plex Sans"?,/,
      );
      await expect(page.locator('body')).toHaveCSS('font-size', '14px');
      // A computed family alone also passes when a font file failed to load.
      expect(
        await page.evaluate(
          async () => (await document.fonts.load('13px "IBM Plex Mono"', 'HD-1042')).length,
        ),
      ).toBeGreaterThan(0);
      if (locale === 'ar') {
        expect(
          await page.evaluate(
            async () => (await document.fonts.load('14px "IBM Plex Sans Arabic"', 'تذكرة')).length,
          ),
        ).toBeGreaterThan(0);
      }

      const other = locale === 'ar' ? 'en' : 'ar';
      await page
        .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: MOCK_USER.name }) })
        .click();
      await page
        .getByRole('menuitem', {
          name: t('common:language.switchTo', { language: t(`common:language.${other}`) }),
        })
        .click();
      await expect(page.locator('html')).toHaveAttribute('lang', other);
      await expect(page.locator('html')).toHaveAttribute('dir', other === 'ar' ? 'rtl' : 'ltr');
      await expect(page.locator('body')).toHaveCSS(
        'font-family',
        other === 'ar' ? /IBM Plex Sans Arabic/ : /^"?IBM Plex Sans"?,/,
      );
      const heading = page.getByRole('heading', {
        name: strings(other)('tickets:views.all'),
        exact: true,
      });
      await expect(heading).toHaveCSS(
        'font-family',
        other === 'ar' ? /IBM Plex Sans Arabic/ : /^"?IBM Plex Sans"?,/,
      );
      await expect(
        page
          .getByRole('region', { name: strings(other)('tickets:header.label') })
          .getByText('HD-1042', { exact: true }),
      ).toHaveCSS('font-family', /IBM Plex Mono/);

      // Unlike the ticket's Typography variant, this table cell uses the
      // family-only helper and therefore catches missing --hd-font-* variables.
      const otherT = strings(other);
      await openSettingsArea(page, otherT, 'developers');
      const prefix = page
        .getByRole('table', { name: otherT('developers:keys.tableLabel') })
        .getByText(/^hd_live_/)
        .first();
      await expect(prefix).toHaveCSS('font-family', /IBM Plex Mono/);
    });
  });
}

// Explicit content language must select Arabic even under the English theme.
test('uses the Arabic face for the article language option (#339)', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openTicket(page, locale, 'HD-1030');
  await page.getByRole('button', { name: t('tickets:assist.button') }).click();
  await page
    .getByRole('menuitem', { name: new RegExp(t('tickets:assist.menu.draftArticle')) })
    .click();
  const dialog = page.getByRole('dialog', { name: new RegExp(t('tickets:assist.draft.title')) });
  await dialog.getByRole('combobox', { name: t('tickets:assist.draft.language') }).click();
  const arabic = page.locator('[role="option"][lang="ar"]');
  await expect(arabic).toBeVisible();
  await expect(arabic).toHaveCSS('font-family', /IBM Plex Sans Arabic/);
});
