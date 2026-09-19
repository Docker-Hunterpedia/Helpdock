import { expect, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import {
  ACCOUNT_EMAIL_ENV,
  ACCOUNT_PASSWORD_ENV,
  INVITE_TOKEN_ENV,
  INVITEE_EMAIL,
  SKIP_ENV,
  TOTP_SECRET_ENV,
} from './install.js';

/**
 * M0-06 against the real api: an invitation accepted, a second factor enrolled,
 * and the account signing in with what it just set up.
 *
 * The mock suite covers the screens in both languages. What this adds is
 * everything under them — argon2 hashing the first password an account ever
 * has, the invite token spent in Redis with a `GETDEL`, the `user_brand_roles`
 * row read back through row-level security, and the TOTP secret encrypted
 * under `APP_MASTER_KEY` and decrypted to check a code somebody typed.
 *
 * One worker and one install, so these run in order: the invitation accepted in
 * the first test is the account signing in in the last.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

const NEW_PASSWORD = 'an invited person password';

const admin = () => ({
  email: process.env[ACCOUNT_EMAIL_ENV] ?? '',
  password: process.env[ACCOUNT_PASSWORD_ENV] ?? '',
  totpSecret: process.env[TOTP_SECRET_ENV] ?? '',
});

/** Signed in as the seeded install admin, through the second factor. */
const signInAsAdmin = async (page: import('@playwright/test').Page): Promise<void> => {
  const { email, password, totpSecret } = admin();

  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(email);
  await page.getByLabel(t('auth:signIn.passwordLabel')).fill(password);
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();

  await page.getByLabel(t('auth:totp.codeLabel')).fill(await generate({ secret: totpSecret }));
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
};

test.describe('staff and roles against the real api', () => {
  test('shows the seeded invitation as pending, and sends another', async ({ page }) => {
    await signInAsAdmin(page);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.staff')) }).click();

    const table = page.getByRole('table');
    await expect(table.getByText(INVITEE_EMAIL)).toBeVisible();
    await expect(
      table
        .getByRole('row')
        .filter({ hasText: INVITEE_EMAIL })
        .getByText(/Invited/),
    ).toBeVisible();

    await page.getByRole('button', { name: t('staff:invite'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(t('staff:inviteDialog.emailLabel')).fill('second@helpdock.test');
    await dialog.getByRole('button', { name: t('staff:inviteDialog.submit') }).click();

    await expect(
      page.getByText(t('staff:toast.invited', { email: 'second@helpdock.test' })),
    ).toBeVisible();
    await expect(table.getByText('second@helpdock.test')).toBeVisible();
  });

  test('accepts an invitation, enrols a second factor, and signs in with both', async ({
    page,
  }) => {
    const token = process.env[INVITE_TOKEN_ENV] ?? '';

    // 1. The link from the invitation, read without spending it.
    await page.goto(`/invite/${token}`);
    await expect(
      page.getByRole('heading', { name: t('auth:invite.title'), level: 1 }),
    ).toBeVisible();
    await expect(page.getByText(new RegExp(INVITEE_EMAIL))).toBeVisible();

    // 2. Accepting it: the first password this account has ever had.
    await page.getByLabel(t('auth:invite.nameLabel')).fill('Invited Person');
    await page.getByLabel(t('auth:invite.passwordLabel')).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: t('auth:invite.submit') }).click();

    // The install does not require two-factor, so acceptance lands in the shell.
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();

    // 3. Enrolling a second factor from the security page.
    await page
      .getByRole('button', {
        name: t('admin:currentUser.menuLabel', { name: 'Invited Person' }),
      })
      .click();
    await page.getByRole('menuitem', { name: t('me:security.title') }).click();
    await page.getByRole('button', { name: t('me:twoFactor.enable') }).click();

    // Scoped to the panel the "Copy key" button sits in, and only after the
    // enrolment screen has actually painted: `bdi` is a general wrapper the
    // app uses for any mixed-direction value, so an unscoped match would pick
    // up whatever was still on the previous screen.
    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.title'), level: 1 }),
    ).toBeVisible();
    const keyPanel = page
      .getByRole('button', { name: t('auth:enrolment.step1.copyKey') })
      .locator('xpath=..');
    const secret = (await keyPanel.locator('bdi').textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    await page
      .getByLabel(t('auth:enrolment.step1.codeLabel'))
      .fill(await generate({ secret, period: 30 }));
    await page.getByRole('button', { name: t('auth:enrolment.step1.submit') }).click();

    const codes = page.getByRole('list', { name: t('auth:enrolment.step2.listLabel') });
    await expect(codes.getByRole('listitem')).toHaveCount(10);
    await page.getByLabel(t('auth:enrolment.step2.confirm')).check();
    await page.getByRole('button', { name: t('auth:enrolment.step2.continue') }).click();
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();

    // 4. Signing out, and back in with the password and a code — which is the
    //    whole point: everything above was written to a real database.
    await page
      .getByRole('button', {
        name: t('admin:currentUser.menuLabel', { name: 'Invited Person' }),
      })
      .click();
    await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();
    await expect(
      page.getByRole('heading', { name: t('auth:signIn.title'), level: 1 }),
    ).toBeVisible();

    await page.getByLabel(t('auth:signIn.emailLabel')).fill(INVITEE_EMAIL);
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill(NEW_PASSWORD);
    await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();

    await expect(page.getByRole('heading', { name: t('auth:totp.title') })).toBeVisible();
    await page.getByLabel(t('auth:totp.codeLabel')).fill(await generate({ secret, period: 30 }));
    await page.getByRole('button', { name: t('auth:totp.submit') }).click();

    await expect(page.getByRole('navigation', { name: t('admin:nav.label') })).toBeVisible();

    // 5. The link is spent: a second attempt with it is refused.
    await page.goto(`/invite/${token}`);
    await expect(
      page.getByRole('heading', { name: t('auth:invite.expiredTitle'), level: 1 }),
    ).toBeVisible();
  });
});
