import {
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  type Page,
  type PlaywrightTestOptions,
} from '@playwright/test';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, TOTP_SECRET_ENV } from './install.js';
import { freshTotpCode } from './totp.js';

/**
 * The seeded account, signed in once per worker and shared by every spec that
 * runs as it.
 *
 * Two things in the api make signing in per test a bad idea. The sign-in form
 * allows twenty attempts per address in fifteen minutes (`SIGN_IN_IP_RULE`),
 * and the whole suite comes from one address, so the twenty-first spec to sign
 * in would be refused however right its password was. And each thirty-second
 * step of an authenticator is accepted once (ASVS 2.8.4), so a sign-in after
 * the first two in a step has to wait for the clock, which made every spec
 * half a minute slower than its own work.
 *
 * So the browser context is a worker fixture: it signs in through the real
 * form, the real second factor and the real refresh cookie, and every test gets
 * a fresh page in it. The refresh cookie rotates on every use, and one context
 * holds the one current copy, which is why this is a shared context and not a
 * saved `storageState` replayed into many — the second context to present a
 * rotated token would be taken for a thief and end the family.
 *
 * A spec that needs to be nobody, or somebody else — the sign-in spec, an
 * invitation being accepted — opens a context of its own from `browser`.
 */

const t = strings('en');

/** Signs the page in as the seeded install admin, through the second factor. */
export const signInAsAdmin = async (page: Page): Promise<void> => {
  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(process.env[ACCOUNT_EMAIL_ENV] ?? '');
  await page
    .getByLabel(t('auth:signIn.passwordLabel'))
    .fill(process.env[ACCOUNT_PASSWORD_ENV] ?? '');
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();

  await page
    .getByLabel(t('auth:totp.codeLabel'))
    .fill(await freshTotpCode(process.env[TOTP_SECRET_ENV] ?? ''));
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
};

/** Loads the admin at its home, which lands the signed-in page in the account's first brand. */
export const openAdmin = async (page: Page): Promise<void> => {
  await page.goto('/');
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
};

/**
 * `browser.newContext` takes none of the project's `use` options by itself;
 * these are the ones a screen can tell apart, carried over by hand.
 */
export const contextOptionsOf = ({
  baseURL,
  locale,
  viewport,
}: Partial<
  Pick<PlaywrightTestOptions, 'baseURL' | 'locale' | 'viewport'>
>): BrowserContextOptions => ({
  ...(baseURL === undefined ? {} : { baseURL }),
  ...(locale === undefined ? {} : { locale }),
  ...(viewport === undefined || viewport === null ? {} : { viewport }),
});

export const test = base.extend<
  Record<never, never>,
  { adminContext: BrowserContext; admin: Page }
>({
  adminContext: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext(contextOptionsOf(workerInfo.project.use));
      const page = await context.newPage();
      await signInAsAdmin(page);
      await page.close();
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],
  /**
   * `admin`: one page of that context that lives as long as the worker, for
   * the specs that drive the admin beside a visitor from `beforeAll`, where
   * only a worker fixture can be had. It is defined here rather than in those
   * specs' helpers because every worker fixture a file adds gives it a worker
   * of its own, and a second worker is a second sign-in.
   */
  admin: [
    async ({ adminContext }, use) => {
      const page = await adminContext.newPage();
      await use(page);
      await page.close();
    },
    { scope: 'worker' },
  ],
  context: async ({ adminContext }, use) => {
    await use(adminContext);
  },
  // A page of the shared context per test, closed after it; the built-in
  // fixture leaves that to the context, which here outlives the test.
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
