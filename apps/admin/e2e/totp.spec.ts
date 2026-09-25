import { MOCK_RECOVERY_CODE } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { submitPassword } from './flows.js';
import { strings } from './strings.js';

test.describe('the second factor', () => {
  test('counts the attempts down and locks on the third wrong code', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale);
    const code = page.getByLabel(t('auth:totp.codeLabel'));
    const verify = page.getByRole('button', { name: t('auth:totp.submit') });

    for (const attemptsLeft of [2, 1]) {
      await code.fill('000000');
      await verify.click();
      await expect(page.getByRole('alert')).toHaveText(
        t('auth:totp.mismatch', { count: attemptsLeft }),
      );
    }

    await code.fill('000000');
    await verify.click();

    await expect(page.getByRole('alert')).toHaveText(t('auth:totp.locked'));
    await expect(code).toBeDisabled();
    await expect(verify).toBeDisabled();
  });

  test('swaps in place to a recovery code and signs in with it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale);
    await page.getByRole('button', { name: t('auth:totp.useRecoveryCode') }).click();

    await expect(page.getByLabel(t('auth:totp.recoveryCodeLabel'))).toBeVisible();
    await expect(page.getByLabel(t('auth:totp.trustBrowser'))).toBeHidden();

    await page.getByLabel(t('auth:totp.recoveryCodeLabel')).fill(MOCK_RECOVERY_CODE);
    await page.getByRole('button', { name: t('auth:totp.submit') }).click();

    await expect(
      page.getByRole('heading', { name: t('tickets:views.myOpen'), level: 1 }),
    ).toBeVisible();
  });

  test('takes only six digits however they are typed', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await submitPassword(page, locale);
    const code = page.getByLabel(t('auth:totp.codeLabel'));
    await code.pressSequentially('12ab3456789');

    await expect(code).toHaveValue('123456');
  });
});
