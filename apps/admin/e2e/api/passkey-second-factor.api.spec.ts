import { expect, type Page, test } from '@playwright/test';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';
import { freshTotpCode } from './totp.js';

/**
 * A passkey as the second factor against the real api (M18-03): a Chromium
 * virtual authenticator makes a real credential, and the second step of the
 * next sign-in is answered with a signature the api verifies. The mock suite
 * (`second-factor-passkey.spec.ts`) covers the states in both languages; this
 * covers the wiring: options a browser accepts, the ceremony and challenge
 * tied together, and the shared attempts.
 *
 * It signs in with a context of its own, so the seeded account's shared
 * session is untouched, and it removes the passkey again so the account is as
 * it was found: an install admin whose second step is a code.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');

const account = () => ({
  email: process.env[ACCOUNT_EMAIL_ENV] ?? '',
  password: process.env[ACCOUNT_PASSWORD_ENV] ?? '',
  totpSecret: process.env[TOTP_SECRET_ENV] ?? '',
});

const submitPassword = async (page: Page): Promise<void> => {
  const { email, password } = account();
  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(email);
  await page.getByLabel(t('auth:signIn.passwordLabel')).fill(password);
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
};

test.describe('a passkey as the second factor, against the real api', () => {
  test('adds one, answers the next second step with it, and shares the attempts with codes', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL ?? '' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const { totpSecret, password } = account();

    try {
      // 1. Password and code, then add a passkey from the security page.
      await submitPassword(page);
      await page.getByLabel(t('auth:totp.codeLabel')).fill(await freshTotpCode(totpSecret));
      await page.getByRole('button', { name: t('auth:totp.submit') }).click();
      await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
      await page
        .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: 'Dev Admin' }) })
        .click();
      await page.getByRole('menuitem', { name: t('me:security.title') }).click();
      const card = page.getByRole('region', { name: t('me:passkeys.title') });
      await card.getByRole('button', { name: t('me:passkeys.add') }).click();
      const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
      await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(password);
      await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();
      await page
        .getByRole('dialog', { name: t('me:passkeys.nameTitle') })
        .getByLabel(t('me:passkeys.nameLabel'))
        .fill('Virtual key');
      await page
        .getByRole('dialog', { name: t('me:passkeys.nameTitle') })
        .getByRole('button', { name: t('me:passkeys.save') })
        .click();
      await expect(card.getByText('Virtual key')).toBeVisible();

      // 2. Sign out; the second step now offers the passkey first, and a code too.
      await page
        .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: 'Dev Admin' }) })
        .click();
      await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();
      await submitPassword(page);
      await expect(
        page.getByRole('heading', { name: t('auth:secondFactor.title'), level: 1 }),
      ).toBeVisible();
      await expect(page.getByLabel(t('auth:totp.codeLabel'))).toBeVisible();

      // 3. A wrong code spends the first of three attempts, a passkey the real
      //    api verifies is the second step, and the credential records its use.
      await page.getByLabel(t('auth:totp.codeLabel')).fill('000000');
      await page.getByRole('button', { name: t('auth:secondFactor.submitCode') }).click();
      await expect(page.getByRole('alert')).toHaveText(t('auth:totp.mismatch', { count: 2 }));
      await page.getByRole('button', { name: t('auth:secondFactor.usePasskey') }).click();
      await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
      expect(
        (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
      ).toHaveLength(1);

      // 4. Remove it again with the passkey itself, so the account is as found.
      await page
        .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: 'Dev Admin' }) })
        .click();
      await page.getByRole('menuitem', { name: t('me:security.title') }).click();
      await card
        .getByRole('button', { name: t('me:passkeys.removeLabel', { name: 'Virtual key' }) })
        .click();
      await page
        .getByRole('dialog', { name: t('me:passkeys.stepUpTitle') })
        .getByRole('button', { name: t('me:passkeys.usePasskey') })
        .click();
      await page
        .getByRole('dialog', { name: t('me:passkeys.removeTitle', { name: 'Virtual key' }) })
        .getByRole('button', { name: t('me:passkeys.removeConfirm') })
        .click();
      await expect(card.getByText(t('me:passkeys.emptyTitle'))).toBeVisible();
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await context.close();
    }
  });
});
