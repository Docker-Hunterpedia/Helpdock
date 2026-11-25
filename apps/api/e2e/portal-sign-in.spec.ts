import AxeBuilder from '@axe-core/playwright';
import { createI18n } from '@helpdock/i18n';
import { test as base, expect, type Page } from '@playwright/test';
import { HELP_CENTER_PORTAL_URL, PORTAL_COMPANY } from './fixtures.ts';

/**
 * The customer portal's sign-in (M21-02; artboard `HelpCenter/Portal-SignIn`) in
 * a real browser, in both languages: the form, "Check your email", the Continue
 * page, the signed-in header menu and Sign out, and the failure paths (a
 * malformed address, an expired link, a used link and the rate limit). Every
 * page goes through axe. The server is `help-center-server.ts`'s portal twin,
 * with the portal's store in memory; what the same code does against Postgres
 * is `portal-sign-in.integration.test.ts`.
 *
 * Each test signs in with an address of its own, so the two languages and the
 * tests can run side by side against one server.
 */

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-0000000000b1';
const BASE = `/hc/${BRAND}`;

const test = base.extend<{ pageLocale: 'en' | 'ar' }>({
  pageLocale: ['en', { option: true }],
});

test.use({ reducedMotion: 'reduce', baseURL: HELP_CENTER_PORTAL_URL });

const strings = (locale: 'en' | 'ar') => {
  const t = createI18n({ lng: locale }).getFixedT(locale, 'hcSite');
  return (key: string, options?: Record<string, unknown>): string =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);
};

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map(
    (violation) => `${violation.id} (${violation.nodes.length}): ${violation.help}`,
  );
}

const address = (locale: string, name: string): string => `${name}-${locale}@acme.example`;

const openForm = async (page: Page, locale: 'en' | 'ar') => {
  await page.goto(`${BASE}/sign-in?lang=${locale}`);
  await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
};

const submit = async (page: Page, t: ReturnType<typeof strings>, email: string) => {
  await page.getByLabel(t('portal.signIn.email')).fill(email);
  await page.getByRole('button', { name: t('portal.signIn.submit') }).click();
};

/** The link the server emailed to an address, as a path the browser can open. */
const emailedLink = async (page: Page, email: string): Promise<string> => {
  const response = await page.request.get(`/__e2e/link?email=${encodeURIComponent(email)}`);
  const { url } = (await response.json()) as { url: string | null };
  expect(url, `a link for ${email}`).not.toBeNull();
  const link = new URL(url ?? '');
  return `${link.pathname}${link.search}`;
};

test('signs in end to end: the form, the email, Continue, the header menu and Sign out', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  const email = address(pageLocale, 'flow');
  await openForm(page, pageLocale);
  await expect(
    page.getByRole('heading', { level: 1, name: t('portal.signIn.title') }),
  ).toBeFocused();
  expect(await violations(page)).toEqual([]);

  await submit(page, t, email);
  await expect(page.getByRole('heading', { level: 1, name: t('portal.sent.title') })).toBeVisible();
  await expect(page.locator('main')).toContainText(email);
  expect(await violations(page)).toEqual([]);

  const link = await emailedLink(page, email);
  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: t('portal.confirm.title') }),
  ).toBeVisible();
  await expect(page.locator('main')).toContainText(email);
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: t('portal.confirm.submit') }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/tickets\\?lang=${pageLocale}$`));
  await expect(
    page.getByRole('heading', { level: 1, name: t('portal.nav.tickets') }),
  ).toBeVisible();

  const menu = page.getByRole('group').filter({ hasText: email }).first();
  await page.locator('summary').click();
  await expect(menu).toContainText(t('portal.menu.signedInAs'));
  await expect(
    page.getByRole('button', { name: t('portal.menu.signOut'), exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: t('portal.menu.signOutEverywhere') }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: t('portal.menu.signOut'), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/${pageLocale}$`));
  await expect(page.getByRole('link', { name: t('portal.nav.signIn') })).toBeVisible();
  // The session is gone: the landing sends the browser back to the form.
  await page.goto(`${BASE}/tickets`);
  await expect(page).toHaveURL(/\/sign-in/);
});

test('shows the signed-in company and address in the menu for a known customer', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  // The memory store knows this address and its company; other tests use their own.
  const email = 'mona@acme.example';
  await openForm(page, pageLocale);
  await submit(page, t, email);
  await page.goto(await emailedLink(page, email));
  await page.getByRole('button', { name: t('portal.confirm.submit') }).click();

  await page.locator('summary').click();
  await expect(page.locator('.hd-menu-panel')).toContainText(PORTAL_COMPANY);
  expect(await violations(page)).toEqual([]);
});

test('a malformed address gets a field error, announced and tied to the field', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  await openForm(page, pageLocale);
  await submit(page, t, 'not an address');

  await expect(
    page.getByRole('alert').filter({ hasText: t('portal.signIn.invalid') }),
  ).toBeVisible();
  const field = page.getByLabel(t('portal.signIn.email'));
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAttribute('aria-describedby', 'hd-email-error');
  await expect(field).toHaveValue('not an address');
  await expect(
    page.getByRole('heading', { level: 1, name: t('portal.signIn.title') }),
  ).toBeFocused();
  expect(await violations(page)).toEqual([]);
});

test('an expired link has its own page with a way forward', async ({
  page,
  pageLocale,
  request,
}) => {
  const t = strings(pageLocale);
  const email = address(pageLocale, 'expired');
  await openForm(page, pageLocale);
  await submit(page, t, email);
  const link = await emailedLink(page, email);
  await request.post(`/__e2e/expire?email=${encodeURIComponent(email)}`);

  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: t('portal.expired.title') }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: t('portal.expired.newLink') })).toBeVisible();
  await expect(page.getByRole('link', { name: t('portal.nav.tickets') }).last()).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('a used link says so, and Continue cannot be pressed twice', async ({ page, pageLocale }) => {
  const t = strings(pageLocale);
  const email = address(pageLocale, 'used');
  await openForm(page, pageLocale);
  await submit(page, t, email);
  const link = await emailedLink(page, email);
  await page.goto(link);
  await page.getByRole('button', { name: t('portal.confirm.submit') }).click();
  await expect(page).toHaveURL(new RegExp(`${BASE}/tickets\\?lang=${pageLocale}$`));

  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: t('portal.used.title') })).toBeVisible();
  await expect(page.getByRole('link', { name: t('portal.expired.newLink') })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('the sixth request for one address in an hour shows the warning and disables the button', async ({
  page,
  pageLocale,
}) => {
  const t = strings(pageLocale);
  const email = address(pageLocale, 'limited');
  for (let n = 0; n < 5; n += 1) {
    await openForm(page, pageLocale);
    await submit(page, t, email);
    await expect(
      page.getByRole('heading', { level: 1, name: t('portal.sent.title') }),
    ).toBeVisible();
  }
  await openForm(page, pageLocale);
  await submit(page, t, email);

  await expect(
    page.getByRole('alert').filter({ hasText: t('portal.signIn.tooMany') }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: t('portal.signIn.submit') })).toBeDisabled();
  expect(await violations(page)).toEqual([]);
});
