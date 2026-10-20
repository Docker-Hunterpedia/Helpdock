import { expect, type Page, test } from '@playwright/test';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';
import { freshTotpCode } from './totp.js';

/**
 * Passwordless sign-in against the real api (M18-04): a Chromium virtual
 * authenticator makes a real discoverable credential, and the next sign-in is
 * a click on "Sign in with a passkey" that the api verifies, with user
 * verification required and no second step. The mock suite
 * (`passkey-sign-in.spec.ts`) covers the states in both languages; this covers
 * the wiring: options that name nobody, the ceremony tied to the assertion, the
 * session it opens, and the one refusal for a credential the account no longer
 * holds.
 *
 * It signs in with a context of its own, so the seeded account's shared
 * session is untouched, and it removes the passkey again so the account is as
 * it was found.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');
const MENU = { name: 'Dev Admin' };

const account = () => ({
  email: process.env[ACCOUNT_EMAIL_ENV] ?? '',
  password: process.env[ACCOUNT_PASSWORD_ENV] ?? '',
  totpSecret: process.env[TOTP_SECRET_ENV] ?? '',
});

const signOut = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: t('admin:currentUser.menuLabel', MENU) }).click();
  await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();
  await page.getByLabel(t('auth:signIn.emailLabel')).waitFor();
};

test.describe('passwordless sign-in, against the real api', () => {
  test('signs in with a saved passkey and no second step, then refuses one the account no longer holds', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL ?? '' });
    const page = await context.newPage();
    // Chromium's virtual authenticator answers a conditional request on its own, which a
    // person's browser never does; the sign-in page would sign in before this spec presses.
    await context.addInitScript(() => {
      PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    });
    const cdp = await context.newCDPSession(page);
    // Chromium's virtual authenticator answers a conditional request on its own, which a
    // person's browser never does; the sign-in page would sign in before this spec types.
    await context.addInitScript(() => {
      PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    });

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
    const { email, password, totpSecret } = account();

    try {
      // 1. Password and code, then add a passkey from the security page.
      await page.goto('/sign-in');
      await page.getByLabel(t('auth:signIn.emailLabel')).fill(email);
      await page.getByLabel(t('auth:signIn.passwordLabel')).fill(password);
      await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
      await page.getByLabel(t('auth:totp.codeLabel')).fill(await freshTotpCode(totpSecret));
      await page.getByRole('button', { name: t('auth:totp.submit') }).click();
      await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
      await page.getByRole('button', { name: t('admin:currentUser.menuLabel', MENU) }).click();
      await page.getByRole('menuitem', { name: t('me:security.title') }).click();
      const card = page.getByRole('region', { name: t('me:passkeys.title') });
      await card.getByRole('button', { name: t('me:passkeys.add') }).click();
      const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
      await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(password);
      await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();
      const naming = page.getByRole('dialog', { name: t('me:passkeys.nameTitle') });
      await naming.getByLabel(t('me:passkeys.nameLabel')).fill('Virtual key');
      await naming.getByRole('button', { name: t('me:passkeys.save') }).click();
      await expect(card.getByText('Virtual key')).toBeVisible();

      // 2. Signed out, the passkey alone is the whole sign-in: no password, no code step.
      await signOut(page);
      await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveAttribute(
        'autocomplete',
        'username webauthn',
      );
      await page.getByRole('button', { name: t('auth:signIn.passkey') }).click();
      await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
      await expect(
        page.getByRole('heading', { name: t('auth:secondFactor.title'), level: 1 }),
      ).toHaveCount(0);

      // 3. Remove it from the account, keep it in the authenticator: the api no
      //    longer knows the credential, and says so in the one way it says everything.
      await page.getByRole('button', { name: t('admin:currentUser.menuLabel', MENU) }).click();
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
      await signOut(page);

      await page.getByRole('button', { name: t('auth:signIn.passkey') }).click();

      await expect(
        page.getByRole('alert').filter({ hasText: t('auth:signIn.passkeyRefused') }),
      ).toBeVisible();
      await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toBeVisible();
    } finally {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await context.close();
    }
  });
});
