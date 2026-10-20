import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  MOCK_PASSKEYS_STORAGE,
  MOCK_PASSWORD,
  MOCK_TOTP_CODE,
  MOCK_USER,
} from '../src/auth/mock-api.js';
import { MOCK_ENROLMENT_CODE, MOCK_TOTP_SECRET } from '../src/staff/mock-api.js';
import { expect, test } from './fixtures.js';
import { fillSignIn, openSecurity, submitPassword } from './flows.js';
import { strings } from './strings.js';

/**
 * A passkey as the second factor, in a browser, in both languages (M18-03,
 * `Admin/SecondFactor` and `Admin/Enrol2FA-Choose`). The authenticator is
 * Chromium's virtual one, driven over the DevTools WebAuthn domain, so the
 * real `navigator.credentials` calls and `@simplewebauthn/browser` run; the
 * api is the fixture, which counts attempts but does not check signatures
 * (the api suite proves those against the real api).
 */

test.use({ reducedMotion: 'reduce' });

const addVirtualAuthenticator = async (page: Page): Promise<void> => {
  // Chromium's virtual authenticator answers a conditional request on its own, which a
  // person's browser never does; the sign-in page would sign in before this spec types.
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

test.describe('enrolling a second factor from a challenge', () => {
  test('adds a passkey, names it, saves the recovery codes, and the next sign-in asks for it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await seed(page, { enrol: true });

    await submitPassword(page, locale);

    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.title'), level: 1 }),
    ).toBeVisible();
    const passkeyCard = page.getByRole('radio', {
      name: new RegExp(t('auth:enrolment.choose.passkeyTitle')),
    });
    await expect(passkeyCard).toBeChecked();
    await expect(page.getByText(t('auth:enrolment.choose.recommended'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByRole('button', { name: t('auth:enrolment.choose.continue') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.nameTitle'), level: 1 }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
    const name = page.getByLabel(t('auth:enrolment.choose.nameLabel'));
    await name.fill('Work laptop');
    await page.getByRole('button', { name: t('auth:enrolment.choose.submit') }).click();

    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.step2.title'), level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText(t('auth:enrolment.step2.bannerPasskey', { email: MOCK_USER.email })),
    ).toBeVisible();
    await expect(
      page.getByRole('list', { name: t('auth:enrolment.step2.listLabel') }).getByRole('listitem'),
    ).toHaveCount(10);
    await page.getByLabel(t('auth:enrolment.step2.confirm')).check();
    await page.getByRole('button', { name: t('auth:enrolment.step2.continue') }).click();
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();

    // Signing out and in again: the passkey is what the second step offers.
    await page
      .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: MOCK_USER.name }) })
      .click();
    await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();
    await page.getByLabel(t('auth:signIn.emailLabel')).waitFor();
    await fillSignIn(page, locale, MOCK_PASSWORD);

    await expect(
      page.getByRole('heading', { name: t('auth:secondFactor.title'), level: 1 }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByRole('button', { name: t('auth:secondFactor.usePasskey') }).click();
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
  });

  test('leads an authenticator app through the same two steps as before', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { enrol: true });

    await submitPassword(page, locale);
    await page
      .getByRole('radio', { name: new RegExp(t('auth:enrolment.choose.appTitle')) })
      .check();
    await page.getByRole('button', { name: t('auth:enrolment.choose.continue') }).click();

    await expect(page.getByText(MOCK_TOTP_SECRET)).toBeVisible();
    await page.getByLabel(t('auth:enrolment.step1.codeLabel')).fill(MOCK_ENROLMENT_CODE);
    await page.getByRole('button', { name: t('auth:enrolment.step1.submit') }).click();
    await expect(
      page.getByRole('list', { name: t('auth:enrolment.step2.listLabel') }).getByRole('listitem'),
    ).toHaveCount(10);
  });

  test('returns to the chooser with a neutral notice when the prompt is dismissed, and saves nothing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await seed(page, { enrol: true });
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

    await submitPassword(page, locale);
    await page.getByRole('button', { name: t('auth:enrolment.choose.continue') }).click();

    await expect(page.getByText(t('auth:enrolment.choose.cancelled'))).toBeVisible();
    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.title'), level: 1 }),
    ).toBeVisible();

    await page.getByRole('button', { name: t('auth:enrolment.choose.continue') }).click();
    await expect(
      page.getByRole('heading', { name: t('auth:enrolment.choose.nameTitle'), level: 1 }),
    ).toBeVisible();
  });

  test('disables the passkey card with the reason when the browser cannot create passkeys', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { enrol: true });
    await page.addInitScript(() => {
      // @ts-expect-error the test removes the API the browser would have.
      delete window.PublicKeyCredential;
    });

    await submitPassword(page, locale);

    const passkeyCard = page.getByRole('radio', {
      name: new RegExp(t('auth:enrolment.choose.passkeyTitle')),
    });
    await expect(passkeyCard).toBeDisabled();
    await expect(passkeyCard).toHaveAccessibleDescription(t('auth:enrolment.choose.unsupported'));
    await expect(
      page.getByRole('radio', { name: new RegExp(t('auth:enrolment.choose.appTitle')) }),
    ).toBeChecked();
    expect(await violations(page)).toEqual([]);
  });

  test('offers the way out instead of "keep trying"', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await seed(page, { enrol: true });

    await submitPassword(page, locale);
    await page.getByRole('button', { name: t('auth:enrolment.step1.signOut') }).click();

    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toBeVisible();
  });
});

test.describe('the second step of a sign-in', () => {
  test('offers the passkey, then the code, and the code still works', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });

    await submitPassword(page, locale);

    await expect(
      page.getByRole('heading', { name: t('auth:secondFactor.title'), level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('auth:secondFactor.usePasskey') }),
    ).toBeVisible();
    await expect(page.getByText(t('auth:secondFactor.orCode'))).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await page.getByLabel(t('auth:totp.codeLabel')).fill(MOCK_TOTP_CODE);
    await page.getByRole('button', { name: t('auth:secondFactor.submitCode') }).click();
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
  });

  test('says a dismissed prompt is not a failure, and leaves the attempts as they were', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });
    await page.addInitScript(() => {
      navigator.credentials.get = () =>
        Promise.reject(new DOMException('dismissed', 'NotAllowedError'));
    });

    await submitPassword(page, locale);
    await page.getByRole('button', { name: t('auth:secondFactor.usePasskey') }).click();

    await expect(page.getByText(t('auth:secondFactor.cancelled'))).toBeVisible();
    await page.getByLabel(t('auth:totp.codeLabel')).fill('000000');
    await page.getByRole('button', { name: t('auth:secondFactor.submitCode') }).click();
    await expect(page.getByRole('alert')).toHaveText(t('auth:totp.mismatch', { count: 2 }));
  });

  test('locks the passkey button with the code after three wrong codes', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });

    await submitPassword(page, locale);
    const code = page.getByLabel(t('auth:totp.codeLabel'));
    for (let tries = 0; tries < 3; tries += 1) {
      await code.fill('000000');
      await page.getByRole('button', { name: t('auth:secondFactor.submitCode') }).click();
      if (tries < 2) {
        await expect(page.getByRole('alert')).toContainText(/.+/);
      }
    }

    await expect(page.getByRole('alert')).toHaveText(t('auth:totp.locked'));
    await expect(
      page.getByRole('button', { name: t('auth:secondFactor.usePasskey') }),
    ).toBeDisabled();
    await expect(code).toBeDisabled();
  });

  test('shows a passkey-only account no code field, and the recovery code as the other way', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1, noApp: true });

    await submitPassword(page, locale);

    await expect(
      page.getByRole('button', { name: t('auth:secondFactor.usePasskey') }),
    ).toBeVisible();
    await expect(page.getByLabel(t('auth:totp.codeLabel'))).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
    await page.getByRole('button', { name: t('auth:totp.useRecoveryCode') }).click();
    await expect(page.getByLabel(t('auth:totp.recoveryCodeLabel'))).toBeVisible();
  });

  test('is the screen it always was for an account with an authenticator app alone', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale);

    await expect(page.getByRole('heading', { name: t('auth:totp.title'), level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: t('auth:secondFactor.usePasskey') })).toHaveCount(
      0,
    );
  });
});

test.describe('the first passkey from the security page', () => {
  test('hands over the recovery codes drawn with it', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await addVirtualAuthenticator(page);
    await seed(page, { noApp: true });

    // No second factor yet, and none required: a password alone signs in.
    await submitPassword(page, locale);
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
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
    await expect(page.getByText(t('me:twoFactor.newCodesTitle'))).toBeVisible();
    await expect(
      page.getByRole('list', { name: t('auth:enrolment.step2.listLabel') }).getByRole('listitem'),
    ).toHaveCount(10);
  });
});
