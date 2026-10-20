import { generateKeyPairSync, randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_EMAIL, MOCK_PASSKEYS_STORAGE, MOCK_PASSWORD } from '../src/auth/mock-api.js';
import { expect, test } from './fixtures.js';
import { strings } from './strings.js';

/**
 * Signing in with a passkey from the sign-in page, in a browser, in both
 * languages (M18-04, `Admin/Login-Passkey`). The authenticator is Chromium's
 * virtual one, driven over the DevTools WebAuthn domain, holding a resident
 * credential, so the real `navigator.credentials` calls and
 * `@simplewebauthn/browser` run; the api is the fixture, which does not check
 * signatures (the api suite proves those against the real api).
 */

test.use({ reducedMotion: 'reduce' });

/** A virtual authenticator that already holds a discoverable credential for this page's host. */
const holdPasskey = async (
  page: Page,
  { autofill = false }: { readonly autofill?: boolean } = {},
): Promise<void> => {
  if (!autofill) {
    // Chromium's virtual authenticator answers a conditional request on its own, which a
    // person's browser never does; the button is what these tests press.
    await page.addInitScript(() => {
      PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    });
  }
  await page.goto('/sign-in');
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
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await session.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: randomBytes(32).toString('base64'),
      isResidentCredential: true,
      rpId: new URL(page.url()).hostname,
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      userHandle: randomBytes(32).toString('base64'),
      signCount: 0,
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

/** Keeps the browser's autofill request pending, as it is until a person picks from the list. */
const failTheModalPrompt = async (page: Page, name: string): Promise<void> => {
  await page.addInitScript((errorName) => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options) => {
      if (options?.mediation === 'conditional') return get(options);
      return Promise.reject(new DOMException('dismissed', errorName));
    };
  }, name);
};

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('the sign-in page offers a passkey', () => {
  test('draws the button after the divider, with the hint and the autofill token', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });
    await page.goto('/sign-in');

    const passkey = page.getByRole('button', { name: t('auth:signIn.passkey') });
    await expect(passkey).toBeEnabled();
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveAttribute(
      'autocomplete',
      'username webauthn',
    );
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveAccessibleDescription(
      t('auth:signIn.passkeyHint'),
    );
    // Order: password button, divider, passkey, sign-in link.
    const labels = await page.getByRole('button').allInnerTexts();
    expect(labels.indexOf(t('auth:signIn.passkey'))).toBeGreaterThan(
      labels.indexOf(t('auth:signIn.submit')),
    );
    expect(labels.indexOf(t('auth:signIn.passkey'))).toBeLessThan(
      labels.indexOf(t('auth:signIn.magicLink')),
    );
    expect(await violations(page)).toEqual([]);
  });

  test('signs in with the saved passkey, with no password and no second step', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });
    await holdPasskey(page);

    await page.getByRole('button', { name: t('auth:signIn.passkey') }).click();

    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
    await expect(
      page.getByRole('heading', { name: t('auth:secondFactor.title'), level: 1 }),
    ).toHaveCount(0);
  });

  test('signs in from the email field’s autofill when the browser offers the saved passkey', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });

    await holdPasskey(page, { autofill: true });

    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
  });

  test('draws nothing when the install does not offer passkey sign-in', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1, state: 'unavailable' });
    await page.goto('/sign-in');

    await expect(page.getByRole('button', { name: t('auth:signIn.magicLink') })).toBeVisible();
    await expect(page.getByRole('button', { name: t('auth:signIn.passkey') })).toHaveCount(0);
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveAttribute(
      'autocomplete',
      'username',
    );
  });
});

test.describe('when it does not work', () => {
  test('says a closed prompt was cancelled, in a notice that is not an error, and offers it again', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });
    await failTheModalPrompt(page, 'NotAllowedError');
    await page.goto('/sign-in');

    await page.getByRole('button', { name: t('auth:signIn.passkey') }).click();

    const notice = page.getByText(t('auth:signIn.passkeyCancelled'));
    await expect(notice).toBeVisible();
    await expect(page.getByText(t('auth:signIn.passkeyRefused'))).toHaveCount(0);
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('auth:signIn.passkey') })).toBeEnabled();
    expect(await violations(page)).toEqual([]);
  });

  test('gives one message when the passkey is unknown, removed or deactivated', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 0 });
    await holdPasskey(page);

    await page.getByRole('button', { name: t('auth:signIn.passkey') }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: t('auth:signIn.passkeyRefused') }),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);
    // The password form still works beside it.
    await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill(MOCK_PASSWORD);
    await expect(
      page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }),
    ).toBeEnabled();
  });

  test('disables the button with the reason in a browser without WebAuthn', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });
    await page.addInitScript(() => {
      // @ts-expect-error the test removes the API the browser would have.
      delete window.PublicKeyCredential;
    });
    await page.goto('/sign-in');

    const passkey = page.getByRole('button', { name: t('auth:signIn.passkey') });
    await expect(passkey).toBeDisabled();
    await expect(passkey).toHaveAccessibleDescription(t('auth:signIn.passkeyUnsupported'));
    expect(await violations(page)).toEqual([]);
  });

  test('replaces the button with a warning while the install’s passkeys are paused', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1, state: 'paused' });
    await page.goto('/sign-in');

    await expect(page.getByText(t('auth:signIn.passkeyPausedTitle'))).toBeVisible();
    await expect(page.getByText(t('auth:signIn.passkeyPausedBody'))).toBeVisible();
    await expect(page.getByRole('button', { name: t('auth:signIn.passkey') })).toHaveCount(0);
    await expect(page.getByRole('button', { name: t('auth:signIn.magicLink') })).toBeEnabled();
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('the prompt state', () => {
  test('replaces the form while the browser waits, and Cancel returns to it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await seed(page, { count: 1 });
    await page.addInitScript(() => {
      const get = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = (options) =>
        options?.mediation === 'conditional' || !options?.signal
          ? get(options)
          : new Promise((_resolve, reject) => {
              options.signal?.addEventListener('abort', () => {
                reject(new DOMException('aborted', 'AbortError'));
              });
            });
    });
    await page.goto('/sign-in');

    await page.getByRole('button', { name: t('auth:signIn.passkey') }).click();

    await expect(page.getByText(t('auth:signIn.passkeyWaiting'))).toBeVisible();
    await expect(page.getByText(t('auth:signIn.passkeyWaitingBody'))).toBeVisible();
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toHaveCount(0);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('auth:signIn.passkeyCancel') }).click();

    await expect(page.getByText(t('auth:signIn.passkeyCancelled'))).toBeVisible();
    await expect(page.getByLabel(t('auth:signIn.emailLabel'))).toBeVisible();
  });
});
