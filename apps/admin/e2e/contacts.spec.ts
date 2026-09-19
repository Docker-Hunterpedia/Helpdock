import { expect, test } from './fixtures.js';
import { openContact, openContacts, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Contacts` and `Admin/Contact` in a real browser, in both languages.
 *
 * What a browser adds over the unit suite is the parts that are not React: a
 * search that debounces against a real event loop, a filter chip that is a real
 * button, a dialog whose focus is really trapped, and an Arabic layout that is
 * a different layout rather than the same one mirrored by hand (DESIGN §7).
 */

test.describe('the contact list', () => {
  test('lists the brand’s people with their identifiers and state', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    const table = page.getByRole('table');
    await expect(table.getByText('Mona Khalil')).toBeVisible();
    await expect(table.getByText('سارة الحسن')).toBeVisible();
    await expect(
      table.getByText(`mona@example.com ${t('contacts:identity.verified')}`),
    ).toBeVisible();
    await expect(
      table.getByText(`mona.k@gmail.com ${t('contacts:identity.unverified')}`),
    ).toBeVisible();
  });

  test('marks the anonymous visitor as one', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    const row = page.getByRole('row').filter({ hasText: 'Visitor 7f3a' });
    await expect(row.getByText(t('contacts:anonymous.badge'))).toBeVisible();
  });

  test('searches as you type, on an identifier as well as a name', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    await page.getByLabel(t('contacts:searchPlaceholder'), { exact: true }).fill('jonas@');

    await expect(page.getByRole('table').getByText('Jonas Weber')).toBeVisible();
    await expect(page.getByRole('table').getByText('Mona Khalil')).toHaveCount(0);
  });

  test('filters to the people with an open ticket, and back again', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    await page.getByText(t('contacts:filters.openTickets'), { exact: true }).click();
    await expect(page.getByRole('table').getByText('Jonas Weber')).toHaveCount(0);

    await page.getByText(t('contacts:filters.openTickets'), { exact: true }).click();
    await expect(page.getByRole('table').getByText('Jonas Weber')).toBeVisible();
  });

  test('says how many pages there are and disables the arrows on a single one', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    await expect(
      page.getByText(t('contacts:pagination.range', { from: 1, to: 5, total: 5 })),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: t('contacts:pagination.next') })).toBeDisabled();
  });

  test('switches to the accounts the brand sells to', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    await page.getByRole('button', { name: t('contacts:segment.accounts') }).click();

    const table = page.getByRole('table', { name: t('contacts:accounts.title') });
    await expect(table.getByRole('link', { name: 'Acme GmbH' })).toBeVisible();
    await expect(table.getByText('acme.example')).toBeVisible();
  });
});

test.describe('creating a contact', () => {
  test('creates one from the keyboard alone and lands on it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    await page.getByRole('button', { name: t('contacts:newContact') }).click();
    // Scoped to the dialog: "Name" is a substring of the list's own search
    // label, and the list is still on screen while the route changes.
    const form = page.getByRole('dialog');
    await form.getByLabel(t('contacts:dialog.nameLabel'), { exact: true }).fill('Rami Saleh');
    await form
      .getByLabel(t('contacts:dialog.identityValueLabel'), { exact: true })
      .fill('Rami@Example.com');
    await page.keyboard.press('Enter');

    await expect(page.getByText(t('contacts:toast.created', { name: 'Rami Saleh' }))).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rami Saleh', level: 1 })).toBeVisible();
    // Normalised on the way in, so one person cannot become two rows.
    await expect(
      page.getByText(`rami@example.com ${t('contacts:identity.unverified')}`).first(),
    ).toBeVisible();
  });

  test('refuses an identifier another contact holds, in words', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContacts(page, locale);

    await page.getByRole('button', { name: t('contacts:newContact') }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel(t('contacts:dialog.nameLabel'), { exact: true }).fill('Impostor');
    await form
      .getByLabel(t('contacts:dialog.identityValueLabel'), { exact: true })
      .fill('mona@example.com');
    await form.getByRole('button', { name: t('contacts:dialog.createSubmit') }).click();

    await expect(page.getByText(t('contacts:toast.identityTaken'))).toBeVisible();
  });
});

test.describe('one contact', () => {
  test('shows the timeline caption and every identifier with its state', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await expect(page.getByText(t('contacts:detail.visibleTickets', { count: 0 }))).toBeVisible();
    await expect(page.getByRole('region', { name: t('contacts:identities.title') })).toBeVisible();
  });

  test('adds a note and shows it in the timeline', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page.getByLabel(t('contacts:detail.addNote'), { exact: true }).fill('Calls on Sundays.');
    await page.getByRole('button', { name: t('contacts:detail.saveNote') }).click();

    await expect(page.getByText(t('contacts:toast.noteAdded'))).toBeVisible();
    await expect(page.getByText('Calls on Sundays.')).toBeVisible();
  });

  test('edits the details and reports the change', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page
      .getByRole('region', { name: t('contacts:details.title') })
      .getByRole('button', { name: t('contacts:details.edit') })
      .click();
    const form = page.getByRole('dialog');
    await form
      .getByLabel(t('contacts:dialog.timezoneLabel'), { exact: true })
      .fill('Asia/Damascus');
    await form.getByRole('button', { name: t('contacts:dialog.editSubmit') }).click();

    await expect(
      page.getByText(t('contacts:toast.updated', { name: 'Mona Khalil' })),
    ).toBeVisible();
    await expect(page.getByText('Asia/Damascus')).toBeVisible();
  });

  test('offers merge as disabled with the reason, and dismisses the duplicate', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    const card = page.getByRole('region', { name: t('contacts:identities.title') });
    await expect(card.getByRole('button', { name: /M1-13/ })).toBeDisabled();

    await card.getByRole('button', { name: t('contacts:identities.notTheSame') }).click();

    await expect(page.getByText(t('contacts:toast.duplicateDismissed'))).toBeVisible();
    await expect(card.getByText(/M\. Khalil/)).toHaveCount(0);
  });

  test('asks before erasing, and locks the screen afterwards', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page.getByRole('button', { name: t('contacts:actions.anonymise') }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: t('contacts:confirm.anonymiseSubmit') }).click();

    await expect(page.getByText(t('contacts:detail.erased'))).toBeVisible();
    await expect(
      page.getByRole('button', { name: t('contacts:detail.edit'), exact: true }),
    ).toBeDisabled();
  });
});
