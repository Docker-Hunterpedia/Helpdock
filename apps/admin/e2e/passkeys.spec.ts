import AxeBuilder from '@axe-core/playwright';
import type { CDPSession, Page } from '@playwright/test';
import { MOCK_PASSKEYS_STORAGE, MOCK_PASSWORD } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { openSecurity, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * Passkeys on `/me/security` in a browser, in both languages (M18-02,
 * `Admin/Profile-Security-Passkeys`). The authenticator is Chromium's virtual
 * one, driven over the DevTools WebAuthn domain, so the real
 * `navigator.credentials` calls and `@simplewebauthn/browser` run; the api is
 * the fixture, which checks proofs but not signatures (the api project's
 * `passkeys.api.spec.ts` runs the same flow against the real api).
 */

/**
 * Transitions are off, as in `a11y.spec.ts`: a menu caught mid-fade reads as low contrast to axe.
 */
test.use({ reducedMotion: 'reduce' });

const addVirtualAuthenticator = async (page: Page): Promise<CDPSession> => {
  const session = await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable');
  await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return session;
};

const seed = async (page: Page, value: Record<string, unknown>): Promise<void> => {
  await page.addInitScript(
    ([key, json]) => {
      window.localStorage.setItem(key as string, json as string);
    },
    [MOCK_PASSKEYS_STORAGE, JSON.stringify(value)],
  );
};

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('passkeys on the security page', () => {
  test('adds one with a real authenticator, names it and lists it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:passkeys.title') });

    await expect(card.getByText(t('me:passkeys.emptyTitle'))).toBeVisible();
    await card.getByRole('button', { name: t('me:passkeys.add') }).click();

    const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    expect(await violations(page)).toEqual([]);
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_PASSWORD);
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();

    const naming = page.getByRole('dialog', { name: t('me:passkeys.nameTitle') });
    await expect(naming.getByLabel(t('me:passkeys.nameLabel'))).toHaveValue(
      t('me:passkeys.nameDefault', { number: 1 }),
    );
    expect(await violations(page)).toEqual([]);
    await naming.getByLabel(t('me:passkeys.nameLabel')).fill('Work laptop');
    await naming.getByRole('button', { name: t('me:passkeys.save') }).click();

    await expect(page.getByText(t('me:passkeys.addedToast'))).toBeVisible();
    await expect(card.getByText('Work laptop')).toBeVisible();
    await expect(
      card.getByRole('button', { name: t('me:passkeys.removeLabel', { name: 'Work laptop' }) }),
    ).toBeVisible();
  });

  test('confirms a rename with the passkey itself', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:passkeys.title') });
    await card.getByRole('button', { name: t('me:passkeys.add') }).click();
    let dialog = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await dialog.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_PASSWORD);
    await dialog.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await page
      .getByRole('dialog', { name: t('me:passkeys.nameTitle') })
      .getByRole('button', { name: t('me:passkeys.save') })
      .click();
    await expect(page.getByText(t('me:passkeys.addedToast'))).toBeVisible();

    const name = t('me:passkeys.nameDefault', { number: 1 });
    await card.getByRole('button', { name: t('me:passkeys.renameLabel', { name }) }).click();
    dialog = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await dialog.getByRole('button', { name: t('me:passkeys.usePasskey') }).click();

    const rename = page.getByRole('dialog', { name: t('me:passkeys.renameTitle') });
    await rename.getByLabel(t('me:passkeys.nameLabel')).fill('Desk key');
    await rename.getByRole('button', { name: t('me:passkeys.save') }).click();

    await expect(page.getByText(t('me:passkeys.renamedToast'))).toBeVisible();
    await expect(card.getByText('Desk key')).toBeVisible();
  });

  test('leaves nothing behind when the browser prompt is dismissed, and can try again', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.addInitScript(() => {
      let refused = true;
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = (options) => {
        if (refused) {
          refused = false;
          return Promise.reject(new DOMException('dismissed', 'NotAllowedError'));
        }
        return create(options);
      };
    });
    await addVirtualAuthenticator(page);
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:passkeys.title') });

    await card.getByRole('button', { name: t('me:passkeys.add') }).click();
    const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_PASSWORD);
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();

    const waiting = page.getByRole('dialog', { name: t('me:passkeys.waitingTitle') });
    await expect(waiting.getByText(t('me:passkeys.cancelled'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await waiting.getByRole('button', { name: t('me:passkeys.close') }).click();
    await expect(card.getByText(t('me:passkeys.emptyTitle'))).toBeVisible();

    await card.getByRole('button', { name: t('me:passkeys.add') }).click();
    await page
      .getByRole('dialog', { name: t('me:passkeys.stepUpTitle') })
      .getByLabel(t('me:passkeys.proofLabel'))
      .fill(MOCK_PASSWORD);
    await page
      .getByRole('dialog', { name: t('me:passkeys.stepUpTitle') })
      .getByRole('button', { name: t('me:passkeys.continue') })
      .click();
    await expect(page.getByRole('dialog', { name: t('me:passkeys.nameTitle') })).toBeVisible();
  });

  test('says a wrong password in the field and starts no prompt', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:passkeys.add') }).click();
    const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill('not the password');
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();

    await expect(stepUp.getByText(t('me:passkeys.proofWrong'))).toBeVisible();
    await expect(page.getByRole('dialog', { name: t('me:passkeys.nameTitle') })).toHaveCount(0);
  });

  test('removes one after naming what still protects the account', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 2 });
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:passkeys.title') });
    expect(await violations(page)).toEqual([]);

    await card
      .getByRole('button', { name: t('me:passkeys.removeLabel', { name: 'YubiKey 1' }) })
      .click();
    const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_PASSWORD);
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();

    const confirm = page.getByRole('dialog', {
      name: t('me:passkeys.removeTitle', { name: 'YubiKey 1' }),
    });
    await expect(confirm.getByText(t('me:passkeys.remainingBoth', { count: 1 }))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await confirm.getByRole('button', { name: t('me:passkeys.removeConfirm') }).click();

    await expect(page.getByText(t('me:passkeys.removedToast'))).toBeVisible();
    await expect(card.getByText('YubiKey 1')).toHaveCount(0);
  });

  test('refuses to remove the only second factor of an account that needs one', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1, onlyFactor: true });
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:passkeys.title') });

    const remove = card.getByRole('button', {
      name: t('me:passkeys.removeLabel', { name: 'MacBook Air · Touch ID' }),
    });
    await expect(remove).toBeDisabled();
    await expect(card.getByText(t('me:passkeys.lastFactor'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('says ten is the most, instead of starting a prompt', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 10 });
    await signIn(page, locale);
    await openSecurity(page, locale);

    await page.getByRole('button', { name: t('me:passkeys.add') }).click();

    const dialog = page.getByRole('dialog', { name: t('me:passkeys.limitTitle', { max: 10 }) });
    await expect(dialog.getByText(t('me:passkeys.limitBody'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await dialog.getByRole('button', { name: t('me:passkeys.close') }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('pauses adding while the install’s address has moved', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1, state: 'paused' });
    await signIn(page, locale);
    await openSecurity(page, locale);

    await expect(page.getByText(t('me:passkeys.paused'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('me:passkeys.add') })).toBeDisabled();
  });

  test('is not drawn at all where passkeys cannot exist', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await seed(page, { state: 'unavailable' });
    await signIn(page, locale);
    await openSecurity(page, locale);
    await page.getByRole('region', { name: t('me:sessions.title') }).waitFor();

    await expect(page.getByRole('region', { name: t('me:passkeys.title') })).toHaveCount(0);
  });
});
