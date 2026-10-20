import { MOCK_INVITE_MISMATCH_ACCOUNT } from '../src/auth/mock-api.js';
import {
  MOCK_ENROLMENT_CODE,
  MOCK_EXPIRED_INVITE_TOKEN,
  MOCK_INVITE_TOKEN,
  MOCK_TOTP_SECRET,
} from '../src/staff/mock-api.js';
import { expectFieldPartsStacked } from './field-layout.js';
import { expect, test } from './fixtures.js';
import { strings } from './strings.js';

/**
 * `Admin/AcceptInvite` and `Admin/Enrol2FA` end to end, in both languages: the
 * only path somebody without an account ever walks.
 */

test.describe('accepting an invitation', () => {
  test('says who invited whom, and to what', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    await expect(
      page.getByRole('heading', { name: t('auth:invite.title'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('karim@helpdock.com')).toBeVisible();
    await expect(page.getByLabel(t('auth:invite.nameLabel'))).toBeVisible();
  });

  test('holds the password floor before asking the api', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    await page.getByLabel(t('auth:invite.nameLabel')).fill('Karim Aziz');
    await page.getByLabel(t('auth:invite.passwordLabel')).fill('short');
    await page.getByRole('button', { name: t('auth:invite.submit') }).click();

    await expect(page.getByText(t('auth:invite.passwordTooShort', { count: 12 }))).toBeVisible();
  });

  test('creates the account and lands on two-factor enrolment', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    await page.getByLabel(t('auth:invite.nameLabel')).fill('Karim Aziz');
    await page.getByLabel(t('auth:invite.passwordLabel')).fill('a long enough password');
    await page.getByRole('button', { name: t('auth:invite.submit') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.title'), level: 1 }),
    ).toBeVisible();
  });

  test('accepts with a provider whose account is the invited address', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    await expect(page.getByRole('group', { name: t('auth:invite.providers.label') })).toBeVisible();
    await page.getByLabel(t('auth:invite.nameLabel')).fill('Karim Aziz');
    await page.getByRole('button', { name: t('auth:signIn.google') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.title'), level: 1 }),
    ).toBeVisible();
  });

  test('offers Microsoft between Google and GitHub, and accepts with it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    const group = page.getByRole('group', { name: t('auth:invite.providers.label') });
    await expect(group.getByRole('button')).toHaveText([
      t('auth:signIn.google'),
      t('auth:signIn.microsoft'),
      t('auth:signIn.github'),
    ]);
    await page.getByLabel(t('auth:invite.nameLabel')).fill('Karim Aziz');
    await group.getByRole('button', { name: t('auth:signIn.microsoft') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.title'), level: 1 }),
    ).toBeVisible();
  });

  test('comes back with the mismatch when the provider account is another address', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);

    await page.getByRole('button', { name: t('auth:signIn.github') }).click();
    await expect(page.getByText(t('auth:invite.nameRequired'))).toBeVisible();

    await page.getByLabel(t('auth:invite.nameLabel')).fill('Karim Aziz');
    await page.getByRole('button', { name: t('auth:signIn.github') }).click();

    await expect(page).toHaveURL(new RegExp(`/invite/${MOCK_INVITE_TOKEN}$`));
    await expect(page.getByRole('status').or(page.getByRole('alert'))).toContainText(
      MOCK_INVITE_MISMATCH_ACCOUNT,
    );
    await expect(page.getByLabel(t('auth:invite.passwordLabel'))).toBeHidden();

    await page.getByRole('button', { name: t('auth:invite.providers.choosePassword') }).click();

    await expect(page.getByLabel(t('auth:invite.nameLabel'))).toHaveValue('Karim Aziz');
    await expect(page.getByLabel(t('auth:invite.passwordLabel'))).toBeVisible();
  });

  test('says plainly when the link has run out, and offers the way back', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto(`/invite/${MOCK_EXPIRED_INVITE_TOKEN}`);

    await expect(
      page.getByRole('heading', { name: t('auth:invite.expiredTitle'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: t('auth:backToSignIn') })).toBeVisible();
    await expect(page.getByLabel(t('auth:invite.passwordLabel'))).toHaveCount(0);
  });
});

test.describe('turning on two-factor', () => {
  test('keeps the code label and hint outside the input', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await page.goto('/sign-in/enrol');

    const label = page.locator('label', { hasText: t('auth:enrolment.step1.codeLabel') });
    const input = page.getByLabel(t('auth:enrolment.step1.codeLabel'));
    const hint = page.getByText(t('auth:enrolment.step1.codeHint'), { exact: true });

    await expectFieldPartsStacked({ label, control: input, hint });
  });

  test('draws the code and offers the key for a device with no camera', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto('/sign-in/enrol');

    await expect(page.getByRole('img', { name: t('auth:enrolment.step1.qrAlt') })).toBeVisible();
    await expect(page.getByText(MOCK_TOTP_SECRET)).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('auth:enrolment.step1.copyKey') }),
    ).toBeVisible();
  });

  test('refuses a code that does not match and stays on the first step', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto('/sign-in/enrol');

    await page.getByLabel(t('auth:enrolment.step1.codeLabel')).fill('000000');
    await page.getByRole('button', { name: t('auth:enrolment.step1.submit') }).click();

    await expect(page.getByText(t('me:twoFactor.codeWrong'))).toBeVisible();
    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.title'), level: 1 }),
    ).toBeVisible();
  });

  test('keeps Continue shut until the recovery codes are acknowledged', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.goto('/sign-in/enrol');

    await page.getByLabel(t('auth:enrolment.step1.codeLabel')).fill(MOCK_ENROLMENT_CODE);
    await page.getByRole('button', { name: t('auth:enrolment.step1.submit') }).click();

    const list = page.getByRole('list', { name: t('auth:enrolment.step2.listLabel') });
    await expect(list.getByRole('listitem')).toHaveCount(10);

    const button = page.getByRole('button', { name: t('auth:enrolment.step2.continue') });
    await expect(button).toBeDisabled();

    await page.getByLabel(t('auth:enrolment.step2.confirm')).check();
    await expect(button).toBeEnabled();
  });
});
