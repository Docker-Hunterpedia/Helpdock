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

/** Opens the Ticketing settings, which land on the Departments tab (M1-01). */
export async function openTicketing(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);

  await page.getByRole('link', { name: new RegExp(t('admin:nav.ticketing')) }).click();
  await page.getByRole('table').waitFor();
}

/**
 * Opens one tab of the Ticketing settings. Through the tab row rather than
 * `page.goto`, for the reason `openStaff` gives: the fixture keeps its session
 * in memory, so a reload signs the browser out.
 *
 * It waits for a control only the *destination* tab has. Waiting for "a table"
 * would return at once, because the tab being left already has one — and the
 * assertions would then run against the list they were told to leave.
 */
export async function openTicketingTab(
  page: Page,
  locale: Locale,
  segment: 'departments' | 'tags' | 'custom-fields' | 'templates',
): Promise<void> {
  const t = strings(locale);
  const tab = {
    departments: 'departments',
    tags: 'tags',
    'custom-fields': 'customFields',
    templates: 'templates',
  } as const;
  const arrived = {
    departments: t('ticketing:departments.add'),
    tags: t('ticketing:tags.add'),
    'custom-fields': t('ticketing:customFields.addTo', {
      target: t('ticketing:customFields.targets.ticket').toLocaleLowerCase(),
    }),
    templates: t('ticketing:templates.add'),
  } as const;

  await openTicketing(page, locale);
  await page.getByRole('tab', { name: t(`ticketing:tabs.${tab[segment]}`) }).click();
  await page.getByRole('button', { name: arrived[segment], exact: true }).waitFor();
}

/**
 * Opens the ticket workspace by clicking the nav item, for the reason
 * `openStaff` gives: the fixture keeps its session in memory, so a `page.goto`
 * would sign the browser out.
 */
export async function openTickets(page: Page, locale: Locale, view?: string): Promise<void> {
  const t = strings(locale);

  await page
    .getByRole('link', { name: new RegExp(t('admin:nav.tickets')) })
    .first()
    .click();
  await page.getByRole('region', { name: t('tickets:list.label') }).waitFor();

  if (view !== undefined) {
    const name = t(`tickets:views.${view}` as 'tickets:views.all');
    await page.getByRole('link', { name, exact: true }).click();
    // The heading rather than the list: the list is already there, and the
    // click is only finished once the list is the one that view asked for.
    await page.getByRole('heading', { name, level: 1 }).waitFor();
  }
}

/** Opens `HD-1042`, the fixture's fullest ticket, from whichever view holds it. */
export async function openTicket(page: Page, locale: Locale, reference = 'HD-1042'): Promise<void> {
  const t = strings(locale);

  await openTickets(page, locale, 'all');
  await page.getByRole('link', { name: new RegExp(reference) }).click();
  await page.getByRole('region', { name: t('tickets:header.label') }).waitFor();
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
