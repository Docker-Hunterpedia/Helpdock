import { strings } from '../strings.js';
import { expect, test } from './admin-session.js';
import { ACCOUNT_PASSWORD_ENV, resetStepUpBudget, SKIP_ENV } from './install.js';

/**
 * Passkeys on `/me/security` against the real api (M18-02): a Chromium virtual
 * authenticator makes a real credential, the api verifies its attestation and
 * assertion, and the card shows what the database holds. The mock suite
 * (`passkeys.spec.ts`) covers the states; this covers the wiring: the options
 * the api mints are options a browser accepts, its origin and RP ID are the
 * page's, and the step-up by passkey is a signature the api checks.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');

test.describe('passkeys against the real api', () => {
  test.beforeEach(resetStepUpBudget);

  test('adds, renames with the passkey itself, and removes one', async ({ page }) => {
    const session = await page.context().newCDPSession(page);
    await session.send('WebAuthn.enable');
    const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    try {
      await page.goto('/me/security');
      const card = page.getByRole('region', { name: t('me:passkeys.title') });
      await card.getByRole('button', { name: t('me:passkeys.add') }).waitFor();

      // Add, confirmed with the password.
      await card.getByRole('button', { name: t('me:passkeys.add') }).click();
      let dialog = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
      await dialog.getByLabel(t('me:passkeys.proofLabel')).fill('not the password');
      await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();
      await expect(dialog.getByText(t('me:passkeys.proofWrong'))).toBeVisible();
      await dialog
        .getByLabel(t('me:passkeys.proofLabel'))
        .fill(process.env[ACCOUNT_PASSWORD_ENV] ?? '');
      await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();

      const naming = page.getByRole('dialog', { name: t('me:passkeys.nameTitle') });
      await naming.getByLabel(t('me:passkeys.nameLabel')).fill('Virtual key');
      await naming.getByRole('button', { name: t('me:passkeys.save') }).click();
      await expect(page.getByText(t('me:passkeys.addedToast'))).toBeVisible();
      await expect(card.getByText('Virtual key')).toBeVisible();
      expect(
        (await session.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
      ).toHaveLength(1);

      // Rename, confirmed by an assertion the api verifies.
      await card
        .getByRole('button', { name: t('me:passkeys.renameLabel', { name: 'Virtual key' }) })
        .click();
      dialog = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
      await dialog.getByRole('button', { name: t('me:passkeys.usePasskey') }).click();
      const rename = page.getByRole('dialog', { name: t('me:passkeys.renameTitle') });
      await rename.getByLabel(t('me:passkeys.nameLabel')).fill('Renamed key');
      await rename.getByRole('button', { name: t('me:passkeys.save') }).click();
      await expect(page.getByText(t('me:passkeys.renamedToast'))).toBeVisible();
      await expect(card.getByText('Renamed key')).toBeVisible();

      // Remove, so the shared account is as it was found.
      await card
        .getByRole('button', { name: t('me:passkeys.removeLabel', { name: 'Renamed key' }) })
        .click();
      dialog = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
      await dialog.getByRole('button', { name: t('me:passkeys.usePasskey') }).click();
      await page
        .getByRole('dialog', { name: t('me:passkeys.removeTitle', { name: 'Renamed key' }) })
        .getByRole('button', { name: t('me:passkeys.removeConfirm') })
        .click();
      await expect(page.getByText(t('me:passkeys.removedToast'))).toBeVisible();
      await expect(card.getByText(t('me:passkeys.emptyTitle'))).toBeVisible();
    } finally {
      await session.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    }
  });

  test('adds nothing when the browser prompt is dismissed', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.credentials.create = () =>
        Promise.reject(new DOMException('dismissed', 'NotAllowedError'));
    });
    await page.goto('/me/security');
    const card = page.getByRole('region', { name: t('me:passkeys.title') });

    await card.getByRole('button', { name: t('me:passkeys.add') }).click();
    const dialog = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await dialog
      .getByLabel(t('me:passkeys.proofLabel'))
      .fill(process.env[ACCOUNT_PASSWORD_ENV] ?? '');
    await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();

    await expect(page.getByText(t('me:passkeys.cancelled'))).toBeVisible();
    await page
      .getByRole('dialog', { name: t('me:passkeys.waitingTitle') })
      .getByRole('button', { name: t('me:passkeys.close') })
      .click();
    await expect(card.getByText(t('me:passkeys.emptyTitle'))).toBeVisible();
  });
});
