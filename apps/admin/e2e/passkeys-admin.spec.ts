import AxeBuilder from '@axe-core/playwright';
import type { CDPSession, Page } from '@playwright/test';
import { MOCK_PASSWORD } from '../src/auth/mock-api.js';
import {
  healthySystemStatus,
  installBrands,
  productMetrics,
} from '../src/screens/admin/system/fixtures.js';
import { MOCK_INSTALL_PASSKEYS_STORAGE } from '../src/settings/mock-api.js';
import { expect, test } from './fixtures.js';
import { openSecurity, openSettings, openSettingsArea, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * The admin side of passkeys (M18-06) in a browser, in both languages: the
 * install admin's Passkeys section on Settings › Authentication
 * (`Admin/Settings-Authentication`), its copy on the System page, and the
 * Security page's "regenerate recovery codes with a passkey" control. The
 * authenticator is Chromium's virtual one over the DevTools WebAuthn domain; the
 * api is the fixture.
 */

test.use({ reducedMotion: 'reduce' });

const seedInstallPasskeys = async (page: Page, value: Record<string, unknown>): Promise<void> => {
  await page.addInitScript(
    ([key, json]) => {
      window.localStorage.setItem(key as string, json as string);
    },
    [MOCK_INSTALL_PASSKEYS_STORAGE, JSON.stringify(value)],
  );
};

const PAUSED = { state: 'paused', rpId: 'desk.helpdock.com', pinnedRpId: 'admin.helpdock.com' };

const addVirtualAuthenticator = async (page: Page): Promise<CDPSession> => {
  await page.addInitScript(() => {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  });
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

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('Settings › Authentication › Passkeys', () => {
  test('shows an available install: the pinned RP ID, read-only, and who uses passkeys', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openSettings(page, locale);
    const section = page.getByRole('region', { name: t('settings:passkeys.title') });

    await expect(section.getByText(t('settings:passkeys.status.available'))).toBeVisible();
    await expect(section.getByLabel(t('settings:passkeys.rpId'))).toHaveAttribute('readonly', '');
    await expect(section.getByLabel(t('settings:passkeys.rpId'))).toHaveValue('localhost');
    await expect(
      section.getByText(t('settings:passkeys.inUseValue', { count: 12, staff: 7 })),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('moves the passkeys after a confirmation when the address changed', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seedInstallPasskeys(page, PAUSED);
    await signIn(page, locale);
    await openSettings(page, locale);
    const section = page.getByRole('region', { name: t('settings:passkeys.title') });

    await expect(section.getByText(t('settings:passkeys.pausedTitle'))).toBeVisible();
    await expect(
      section.locator('bdi[dir="ltr"]', { hasText: 'admin.helpdock.com' }),
    ).toBeVisible();
    await expect(section.locator('bdi[dir="ltr"]', { hasText: 'desk.helpdock.com' })).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await section
      .getByRole('button', { name: t('settings:passkeys.move', { host: 'desk.helpdock.com' }) })
      .click();
    const dialog = page.getByRole('dialog', {
      name: t('settings:passkeys.moveTitle', { host: 'desk.helpdock.com' }),
    });
    await expect(dialog.getByText(t('settings:passkeys.moveBody'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await dialog.getByRole('button', { name: t('settings:passkeys.moveConfirm') }).click();

    await expect(page.getByText(t('settings:passkeys.moved', { count: 12 }))).toBeVisible();
    await expect(section.getByText(t('settings:passkeys.status.available'))).toBeVisible();
    await expect(section.getByLabel(t('settings:passkeys.rpId'))).toHaveValue('desk.helpdock.com');
    await expect(section.getByText(t('settings:passkeys.inUseNone'))).toBeVisible();
  });

  test('keeps everything when the confirmation is cancelled', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seedInstallPasskeys(page, PAUSED);
    await signIn(page, locale);
    await openSettings(page, locale);
    const section = page.getByRole('region', { name: t('settings:passkeys.title') });

    await section
      .getByRole('button', { name: t('settings:passkeys.move', { host: 'desk.helpdock.com' }) })
      .click();
    await page
      .getByRole('dialog', {
        name: t('settings:passkeys.moveTitle', { host: 'desk.helpdock.com' }),
      })
      .getByRole('button', { name: t('common:actions.cancel') })
      .click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      section.getByText(t('settings:passkeys.status.paused'), { exact: true }),
    ).toBeVisible();
  });

  test('will not confirm the move while it would lock accounts out, and says why', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seedInstallPasskeys(page, {
      ...PAUSED,
      blockers: { breakGlassAccounts: 1, secondFactorAccounts: 2 },
    });
    await signIn(page, locale);
    await openSettings(page, locale);

    await page
      .getByRole('region', { name: t('settings:passkeys.title') })
      .getByRole('button', { name: t('settings:passkeys.move', { host: 'desk.helpdock.com' }) })
      .click();
    const dialog = page.getByRole('dialog');

    await expect(dialog.getByText(t('settings:passkeys.moveBlockedTitle'))).toBeVisible();
    await expect(
      dialog.getByText(t('settings:passkeys.moveBlockedSecondFactor', { count: 2 })),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: t('settings:passkeys.moveConfirm') }),
    ).toBeDisabled();
    expect(await violations(page)).toEqual([]);
  });

  test('explains an install without HTTPS', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await seedInstallPasskeys(page, { state: 'unavailable', rpId: null, pinnedRpId: null });
    await signIn(page, locale);
    await openSettings(page, locale);
    const section = page.getByRole('region', { name: t('settings:passkeys.title') });

    await expect(section.getByText(t('settings:passkeys.status.unavailable'))).toBeVisible();
    await expect(section.getByText('APP_URL')).toBeVisible();
    await expect(section.getByRole('button')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
});

test('the System page repeats the address warning and links to Settings', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/install/system', (route) => route.fulfill(json(healthySystemStatus())));
  await page.route('**/api/install/system/metrics', (route) =>
    route.fulfill(json(productMetrics())),
  );
  await page.route('**/api/install/brands', (route) =>
    route.fulfill(json({ brands: installBrands() })),
  );
  await seedInstallPasskeys(page, PAUSED);
  await signIn(page, locale);
  await openSettingsArea(page, t, 'system');

  await expect(page.getByText(t('settings:passkeys.pausedTitle'))).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('link', { name: t('system:passkeysDrift.link') }).click();
  await expect(
    page.getByRole('heading', { name: t('settings:signInMethods.title'), level: 2 }),
  ).toBeVisible();
});

test.describe('Security › regenerate recovery codes with a passkey', () => {
  test('is offered once a passkey exists, asks the browser, and shows the new codes once', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await signIn(page, locale);
    await openSecurity(page, locale);
    const redraw = page.getByRole('button', { name: t('me:twoFactor.regenerateWithPasskey') });
    await expect(redraw).toHaveCount(0);

    const card = page.getByRole('region', { name: t('me:passkeys.title') });
    await card.getByRole('button', { name: t('me:passkeys.add') }).click();
    const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_PASSWORD);
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await page
      .getByRole('dialog', { name: t('me:passkeys.nameTitle') })
      .getByRole('button', { name: t('me:passkeys.save') })
      .click();
    await expect(page.getByText(t('me:passkeys.addedToast'))).toBeVisible();

    await redraw.click();
    const dialog = page.getByRole('dialog', { name: t('me:twoFactor.regenerateWithPasskeyTitle') });
    await expect(dialog.getByText(t('me:twoFactor.regenerateWithPasskeyBody'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await dialog
      .getByRole('button', { name: t('me:twoFactor.regenerateWithPasskeySubmit') })
      .click();

    await expect(page.getByText(t('me:twoFactor.regenerated'))).toBeVisible();
    await expect(page.getByText(t('me:twoFactor.newCodesTitle'))).toBeVisible();
  });

  test('closes quietly, and shows no codes, when the browser prompt is dismissed', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await page.addInitScript(() => {
      navigator.credentials.get = () =>
        Promise.reject(new DOMException('dismissed', 'NotAllowedError'));
    });
    await addVirtualAuthenticator(page);
    await signIn(page, locale);
    await openSecurity(page, locale);
    const card = page.getByRole('region', { name: t('me:passkeys.title') });
    await card.getByRole('button', { name: t('me:passkeys.add') }).click();
    const stepUp = page.getByRole('dialog', { name: t('me:passkeys.stepUpTitle') });
    await stepUp.getByLabel(t('me:passkeys.proofLabel')).fill(MOCK_PASSWORD);
    await stepUp.getByRole('button', { name: t('me:passkeys.continue') }).click();
    await page
      .getByRole('dialog', { name: t('me:passkeys.nameTitle') })
      .getByRole('button', { name: t('me:passkeys.save') })
      .click();
    await expect(page.getByText(t('me:passkeys.addedToast'))).toBeVisible();

    await page.getByRole('button', { name: t('me:twoFactor.regenerateWithPasskey') }).click();
    await page
      .getByRole('dialog', { name: t('me:twoFactor.regenerateWithPasskeyTitle') })
      .getByRole('button', { name: t('me:twoFactor.regenerateWithPasskeySubmit') })
      .click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(t('me:twoFactor.newCodesTitle'))).toHaveCount(0);
  });
});
