import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_TOTP_CODE } from '../src/auth/mock-api.js';
import { strings } from './strings.js';

/**
 * Fills and submits the sign-in form already on screen. Separate from
 * `submitPassword` because a visitor who was redirected here carries a
 * `returnTo` in the url that navigating again would throw away.
 */
export async function fillSignIn(
  page: Page,
  locale: Locale,
  password: string = MOCK_PASSWORD,
): Promise<void> {
  const t = strings(locale);

  await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
  await page.getByLabel(t('auth:signIn.passwordLabel')).fill(password);
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
}

/** Opens the sign-in screen and submits it, landing on the code screen. */
export async function submitPassword(
  page: Page,
  locale: Locale,
  password: string = MOCK_PASSWORD,
): Promise<void> {
  await page.goto('/sign-in');
  await fillSignIn(page, locale, password);
}

/** Answers the second factor with the fixture's code. */
export async function submitTotp(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);

  await page.getByLabel(t('auth:totp.codeLabel')).fill(MOCK_TOTP_CODE);
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
}

/** Signs in all the way through the second factor into the shell. */
export async function signIn(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);

  await submitPassword(page, locale);
  await submitTotp(page, locale);
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
}

/**
 * Opens a screen inside the shell by clicking, never with `page.goto`.
 *
 * The fixture keeps its session in memory — the real one is an `httpOnly`
 * cookie the api owns — so a reload signs the browser out and lands on the
 * sign-in form instead of the screen under test.
 */
export async function openStaff(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);

  await page.getByRole('link', { name: new RegExp(t('admin:nav.staff')) }).click();
  await page.getByRole('table').waitFor();
}

/**
 * Opens the contact list by clicking the nav item, for the reason `openStaff`
 * gives: the fixture keeps its session in memory, so a `page.goto` would sign
 * the browser out.
 */
export async function openContacts(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);

  await page.getByRole('link', { name: new RegExp(t('admin:nav.contacts')) }).click();
  await page.getByRole('heading', { name: t('contacts:title'), level: 1 }).waitFor();
}

/** Opens one contact from the list, by the name on its row. */
export async function openContact(page: Page, locale: Locale, name: string): Promise<void> {
  await openContacts(page, locale);
  await page.getByRole('link', { name, exact: true }).click();
  await page.getByRole('heading', { name, level: 1 }).waitFor();
}

export async function openSecurity(
  page: Page,
  locale: Locale,
  name = 'Lina Haddad',
): Promise<void> {
  const t = strings(locale);

  await page.getByRole('button', { name: t('admin:currentUser.menuLabel', { name }) }).click();
  await page.getByRole('menuitem', { name: t('me:security.title') }).click();
  await page.getByRole('heading', { name: t('me:security.title'), level: 1 }).waitFor();
}
