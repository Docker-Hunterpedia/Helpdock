import type { Locale } from '@helpdock/i18n';
import type { SmtpTestResult } from '@helpdock/schemas';
import type { Page, Route } from '@playwright/test';
import { strings } from './strings.js';

/**
 * A fresh install, faked at the network edge.
 *
 * The wizard decides what it is from a meta tag the api rewrites into
 * `index.html`, so a mock run rewrites the same tag in the response rather than
 * reaching into the app: the document really does arrive saying `fresh`, which
 * is the mechanism under test. The four endpoints are answered the same way,
 * so `HttpSetupApi` — the real one — is what the specs exercise.
 */

export const ADMIN_EMAIL = 'lina@example.com';
export const ADMIN_NAME = 'Lina Haddad';
export const ADMIN_PASSWORD = 'a very long setup passphrase';
export const BRAND_NAME = 'Acme Support';
export const BRAND_PREFIX = 'ACME';
export const SMTP_HOST = 'smtp.example.com';
export const SMTP_FROM = 'support@acme.test';
export const SMTP_FROM_NAME = 'Acme Support';
export const SMTP_RESPONSE = '250 2.0.0 Ok: queued';

export interface FreshInstallOptions {
  /** What `POST /api/install/setup/smtp/test` answers. */
  readonly testResult?: SmtpTestResult;
  /** Whether the finished install demands a second factor before the shell. */
  readonly require2fa?: boolean;
}

const json = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Rewrites the install-state meta tag in whatever document the dev server
 * serves. Registered before the endpoint routes, because Playwright gives the
 * most recently registered handler the first look.
 */
const serveFreshDocument = async (page: Page): Promise<void> => {
  await page.route('**/setup', async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      /<meta name="helpdock:install-state" content="[^"]*" \/>/,
      '<meta name="helpdock:install-state" content="fresh" />',
    );

    await route.fulfill({ response, body });
  });
};

export const freshInstall = async (
  page: Page,
  {
    testResult = { delivered: true, response: SMTP_RESPONSE },
    require2fa = false,
  }: FreshInstallOptions = {},
): Promise<void> => {
  await serveFreshDocument(page);

  await page.route('**/ready', (route) =>
    json(route, { status: 'ready', checks: [{ name: 'database', status: 'up' }] }),
  );

  await page.route('**/api/install/setup/admin', (route) =>
    json(route, {
      setupToken: 'wizard-token',
      expiresInSeconds: 1800,
      admin: {
        id: '0199f4b2-6a91-7c27-9a1f-000000000001',
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
      },
    }),
  );

  await page.route('**/api/install/setup/brand', async (route) => {
    const request = route.request().postDataJSON() as { name: string; prefix: string };

    await json(route, {
      brand: {
        id: '0199f4b2-6a91-7c27-9a1f-00000000000a',
        name: request.name,
        prefix: request.prefix,
        defaultLocale: 'en',
        timezone: 'UTC',
      },
      helpcenterDomain: null,
      departmentCreated: false,
    });
  });

  await page.route('**/api/install/setup/smtp/test', (route) => json(route, testResult));

  await page.route('**/api/install/setup/smtp', async (route) => {
    const request = route.request().postDataJSON() as { skip: boolean };

    await json(route, { configured: !request.skip });
  });

  await page.route('**/api/install/setup/complete', (route) => json(route, { require2fa }));
};

/** Fills step 1 and continues, leaving the brand step on screen. */
export const completeAccountStep = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);

  await page.getByLabel(t('wizard:account.nameLabel')).fill(ADMIN_NAME);
  await page.getByLabel(t('wizard:account.emailLabel')).fill(ADMIN_EMAIL);
  await page.getByLabel(t('wizard:account.passwordLabel')).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: t('wizard:account.submit') }).click();
  await page.getByRole('heading', { name: t('wizard:brand.title') }).waitFor();
};

/** Fills step 2 and continues, leaving the email step on screen. */
export const completeBrandStep = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);

  await page.getByLabel(t('wizard:brand.nameLabel')).fill(BRAND_NAME);
  await page.getByLabel(t('wizard:brand.prefixLabel')).fill(BRAND_PREFIX);
  await page.getByRole('button', { name: t('wizard:brand.submit') }).click();
  await page.getByRole('heading', { name: t('wizard:email.title') }).waitFor();
};

/** Fills the three required SMTP fields, without saving or testing. */
export const fillSmtp = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);

  await page.getByLabel(t('wizard:email.hostLabel')).fill(SMTP_HOST);
  await page.getByLabel(t('wizard:email.fromAddressLabel')).fill(SMTP_FROM);
  await page.getByLabel(t('wizard:email.fromNameLabel')).fill(SMTP_FROM_NAME);
};
