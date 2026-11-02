import type { Locale } from '@helpdock/i18n';
import { expect, type Locator, type Page } from '@playwright/test';
import { MOCK_EMAIL, MOCK_PASSWORD, MOCK_TOTP_CODE } from '../src/auth/mock-api.js';
import { SETTINGS_ENTRIES, settingsGroupLabelKey } from '../src/shell/settings-nav.js';
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

type Translate = ReturnType<typeof strings>;

/**
 * The words a settings page carries in the Settings area's navigation (M14-21).
 * Most are the tab labels they had; the board renamed a few.
 */
const SETTINGS_LABELS: Readonly<Record<string, string>> = {
  'ticketing:tabs.slas': 'admin:settings.entries.slas',
  'channels:tabs.mailboxes': 'admin:settings.entries.mailboxes',
  'channels:tabs.widget': 'admin:settings.entries.widget',
  'channels:tabs.meta': 'admin:settings.entries.meta',
  'brand:tabs.import': 'admin:settings.entries.imports',
};

/** The page each area of the old Admin group opened on, now an entry of the Settings navigation. */
const AREA_LANDINGS = {
  brand: 'brand:tabs.general',
  settings: 'settings:tabs.authentication',
  ticketing: 'ticketing:tabs.departments',
  automation: 'rules:tabs.rules',
  channels: 'channels:tabs.mailboxes',
  ai: 'aiSettings:tabs.providers',
  developers: 'developers:tabs.apiKeys',
  staff: 'admin:nav.staff',
  system: 'admin:nav.system',
} as const;

/** The Settings tree of the main sidebar: groups, each holding its pages. */
const settingsTree = (root: Page | Locator, t: Translate): Locator =>
  root.getByRole('navigation', { name: t('admin:nav.label') }).getByRole('list', {
    name: t('admin:settings.navLabel'),
  });

/** A page link of the Settings tree, by the catalog key of the page's old tab label or name. */
export const settingsTab = (root: Page | Locator, t: Translate, key: string): Locator =>
  settingsTree(root, t).getByRole('link', {
    name: say(t, SETTINGS_LABELS[key] ?? key),
    exact: true,
  });

/** `t` for a key that is a value here rather than a literal, which the catalogs' key type would refuse. */
const say = (t: Translate, key: string): string => (t as (key: string) => string)(key);

/**
 * Opens Settings' tree if it is folded or not yet reached: the sidebar's
 * Settings row goes to the first page of the area (and opens it), or unfolds
 * the tree while the person is already inside it.
 */
export async function openSettingsTree(page: Page | Locator, t: Translate): Promise<void> {
  const tree = settingsTree(page, t);
  if (!(await tree.isVisible())) {
    await page
      .getByRole('navigation', { name: t('admin:nav.label') })
      .getByRole('link', { name: t('admin:nav.settings'), exact: true })
      // The Help center's own "Settings" page has the same name; the section row comes last.
      .last()
      .click();
    await tree.waitFor();
  }
}

/** Clicks a Settings page: opens the tree and the page's group first when they are closed. */
export async function clickSettingsTab(
  page: Page | Locator,
  t: Translate,
  key: string,
): Promise<void> {
  await openSettingsTree(page, t);
  const labelKey = SETTINGS_LABELS[key] ?? key;
  const entry = SETTINGS_ENTRIES.find((candidate) => candidate.labelKey === labelKey);
  if (entry !== undefined) {
    const group = settingsTree(page, t).getByRole('button', {
      name: say(t, settingsGroupLabelKey(entry.group)),
      exact: true,
    });
    if ((await group.getAttribute('aria-expanded')) !== 'true') {
      await group.click();
    }
  }
  await settingsTab(page, t, key).click();
  // The tree reopens its branch when the route changes; wait for that before the next click.
  // A drawer closes itself on the choice, and then there is nothing left to wait on.
  const link = settingsTab(page, t, key);
  await expect
    .poll(async () => ((await link.isVisible()) ? await link.getAttribute('aria-current') : 'page'))
    .toBe('page');
}

/**
 * Opens one area of what used to be the Admin group: the sidebar's single
 * Settings entry first, then the page that area opened on.
 */
export async function openSettingsArea(
  page: Page | Locator,
  t: Translate,
  area: keyof typeof AREA_LANDINGS,
): Promise<void> {
  await clickSettingsTab(page, t, AREA_LANDINGS[area]);
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

  await openSettingsArea(page, t, 'staff');
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

  await openSettingsArea(page, t, 'ticketing');
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
  segment: 'departments' | 'tags' | 'custom-fields' | 'templates' | 'spam',
): Promise<void> {
  const t = strings(locale);
  const tab = {
    departments: 'departments',
    tags: 'tags',
    'custom-fields': 'customFields',
    templates: 'templates',
    spam: 'spam',
  } as const;
  const arrived = {
    departments: t('ticketing:departments.add'),
    tags: t('ticketing:tags.add'),
    'custom-fields': t('ticketing:customFields.addTo', {
      target: t('ticketing:customFields.targets.ticket').toLocaleLowerCase(),
    }),
    templates: t('ticketing:templates.add'),
    spam: t('ticketing:spam.blockList.add'),
  } as const;

  await openTicketing(page, locale);
  await clickSettingsTab(page, t, `ticketing:tabs.${tab[segment]}`);
  await page.getByRole('button', { name: arrived[segment], exact: true }).waitFor();
}

/**
 * Opens the ticket workspace by clicking the nav item, for the reason
 * `openStaff` gives: the fixture keeps its session in memory, so a `page.goto`
 * would sign the browser out.
 */
export async function openTickets(page: Page, locale: Locale, view?: string): Promise<void> {
  const t = strings(locale);

  // The row of the section the person is already in only folds it, so a person on the
  // tickets (where sign-in lands) is already where the click would take them.
  const list = page.getByRole('region', { name: t('tickets:list.label') });
  if (!(await list.isVisible())) {
    await page
      .getByRole('navigation', { name: t('admin:nav.label') })
      .getByRole('link', { name: new RegExp(`^${t('admin:nav.tickets')}`) })
      .first()
      .click();
  }
  await list.waitFor();

  if (view !== undefined) {
    const name = t(`tickets:views.${view}` as 'tickets:views.all');
    await page.getByRole('link', { name, exact: true }).click();
    // The heading rather than the list: the list is already there, and the
    // click is only finished once the list is the one that view asked for.
    await page.getByRole('heading', { name, level: 1 }).waitFor();
  }
}

/** The width from which the details panel sits beside the thread (`DETAILS_BREAKPOINT`, M14-19). */
export const DETAILS_INLINE_WIDTH = 1440;

/**
 * Opens `HD-1042`, the fixture's fullest ticket, from whichever view holds it.
 *
 * The window is widened to {@link DETAILS_INLINE_WIDTH} first, because below it
 * the details panel is a drawer and most specs read the panel in place. A spec
 * about the 1280 px layout passes `{ compact: true }` and keeps the window it has.
 */
export async function openTicket(
  page: Page,
  locale: Locale,
  reference = 'HD-1042',
  { compact = false }: { readonly compact?: boolean } = {},
): Promise<void> {
  const t = strings(locale);

  const size = page.viewportSize();
  if (!compact && size !== null && size.width < DETAILS_INLINE_WIDTH) {
    await page.setViewportSize({ width: DETAILS_INLINE_WIDTH, height: size.height });
  }
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
  await page.getByRole('heading', { name: t('me:account.tabs.security'), level: 1 }).waitFor();
}

/** Opens the install-admin Settings page through the shell. */
export async function openSettings(page: Page, locale: Locale): Promise<void> {
  const t = strings(locale);

  await openSettingsArea(page, t, 'settings');
  await page.getByRole('heading', { name: t('settings:signInMethods.title'), level: 2 }).waitFor();
}

/**
 * Moves to a path without reloading: the mock session lives in memory, so a
 * `page.goto` after sign-in would land on the sign-in screen. The router hears
 * the `popstate` and navigates as it would for a link.
 */
export async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

/**
 * Opens a page of a sidebar section (Contacts or Help center): opens the
 * section with its chevron when it is folded, then follows the page's link.
 */
export async function clickSidebarPage(
  page: Page,
  t: Translate,
  section: 'contacts' | 'helpCenter',
  pageLabel: string | RegExp,
): Promise<void> {
  const nav = page.getByRole('navigation', { name: t('admin:nav.label') });
  // The section's own list: the Help center's "Settings" page shares its name with Settings itself.
  const link = nav
    .getByRole('list', { name: t(`admin:nav.${section}`), exact: true })
    .getByRole('link', { name: pageLabel });
  if (!(await link.isVisible())) {
    await nav
      .getByRole('button', { name: t('admin:nav.pagesOf', { label: t(`admin:nav.${section}`) }) })
      .click();
  }
  await link.click();
}

/** In the Arabic UI the Arabic name of a seeded status is the one on its button and its row. */
export const seededStatusName = (locale: Locale, english: string): string =>
  locale === 'ar'
    ? ((
        {
          Open: 'مفتوحة',
          'Awaiting customer': 'بانتظار العميل',
          'Waiting on supplier': 'بانتظار المورّد',
        } as Record<string, string>
      )[english] ?? english)
    : english;
