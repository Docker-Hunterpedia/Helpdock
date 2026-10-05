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
export const SETUP_KEY = 'q6c2mW1zXk9vT3yRb0nLd8sF4hJ7pA5e';

export interface FreshInstallOptions {
  /** What `POST /api/install/setup/smtp/test` answers. */
  readonly testResult?: SmtpTestResult;
  /** Whether the finished install demands a second factor before the shell. */
  readonly require2fa?: boolean;
  /**
   * Plays an install that set `HD_SETUP_TOKEN` to {@link SETUP_KEY}: the page
   * says a key is required, and step 1 is refused as the api refuses it
   * unless the body carries that key.
   */
  readonly setupKey?: boolean;
  /** Plays a provider that rejects the key on the AI step (M7-10). */
  readonly aiRefused?: boolean;
}

const json = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Rewrites the install-state meta tag in whatever document the dev server
 * serves. Registered before the endpoint routes, because Playwright gives the
 * most recently registered handler the first look.
 */
const serveFreshDocument = async (page: Page, setupKey: boolean): Promise<void> => {
  await page.route('**/setup', async (route) => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace(
        /<meta name="helpdock:install-state" content="[^"]*" \/>/,
        '<meta name="helpdock:install-state" content="fresh" />',
      )
      .replace(
        /<meta name="helpdock:setup-key-required" content="[^"]*" \/>/,
        `<meta name="helpdock:setup-key-required" content="${String(setupKey)}" />`,
      );

    await route.fulfill({ response, body });
  });
};

export const freshInstall = async (
  page: Page,
  {
    testResult = { delivered: true, response: SMTP_RESPONSE },
    require2fa = false,
    setupKey = false,
    aiRefused = false,
  }: FreshInstallOptions = {},
): Promise<void> => {
  await serveFreshDocument(page, setupKey);

  await page.route('**/ready', (route) =>
    json(route, { status: 'ready', checks: [{ name: 'database', status: 'up' }] }),
  );

  await page.route('**/api/install/setup/admin', (route) => {
    const request = route.request().postDataJSON() as { setupKey?: string };
    if (setupKey && request.setupKey !== SETUP_KEY) {
      return json(
        route,
        {
          error: {
            code: 'forbidden',
            message: 'This install asks for its setup key (HD_SETUP_TOKEN) to create the admin',
            requestId: 'mock',
            setup: { reason: 'setup-key-invalid' },
          },
        },
        403,
      );
    }

    return json(route, {
      setupToken: 'wizard-token',
      expiresInSeconds: 1800,
      admin: {
        id: '0199f4b2-6a91-7c27-9a1f-000000000001',
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
      },
    });
  });

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

  await serveAiStep(page, aiRefused);
};

export const AI_MODELS = ['gpt-4.1', 'gpt-4.1-mini'] as const;

/**
 * The AI step's three install routes (M7-10). The step is signed in by the
 * refresh cookie step 2 set; this fake has no cookie, so the refresh answers
 * 401 and the routes below answer whatever the transport sends.
 */
const serveAiStep = async (page: Page, refused: boolean): Promise<void> => {
  await page.route('**/api/auth/refresh', (route) =>
    json(
      route,
      { error: { code: 'unauthenticated', message: 'no session', requestId: 'mock' } },
      401,
    ),
  );
  await page.route('**/api/install/ai/providers/*/models', (route) =>
    refused
      ? json(
          route,
          {
            error: {
              code: 'conflict',
              message: 'The provider could not be asked for its models',
              requestId: 'mock',
              ai: { reason: 'discovery-failed' },
            },
          },
          409,
        )
      : json(route, {
          models: AI_MODELS.map((id) => ({
            id,
            name: id,
            contextWindow: 1_047_576,
            maxTokens: 32_768,
            reasoning: false,
            inputPerMillionUsd: 0.4,
            outputPerMillionUsd: 1.6,
          })),
        }),
  );
  await page.route('**/api/install/ai/providers/*', (route) =>
    json(route, {
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI',
      baseUrl: null,
      authType: 'apiKey',
      oauthExpiresAt: null,
    }),
  );
  await page.route('**/api/install/ai/default-model', (route) =>
    json(route, {
      providers: [],
      kinds: [],
      defaults: { providerId: 'openai', modelId: AI_MODELS[0] },
      locked: { providers: false, defaults: false },
    }),
  );
};

/** Step 4 is optional; specs about something else pass it by. */
export const skipAiStep = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);

  await page.getByRole('heading', { name: t('wizard:ai.title') }).waitFor();
  await page.getByRole('button', { name: t('wizard:ai.skip') }).click();
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
