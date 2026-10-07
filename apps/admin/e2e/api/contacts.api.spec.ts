import type { Page } from '@playwright/test';
import { strings } from '../strings.js';
import { expect, openAdmin, test } from './admin-session.js';
import { SKIP_ENV } from './install.js';

/**
 * M1-04 against the real api: a contact created in a browser, stored in
 * Postgres under row-level security, and read back on its own screen.
 *
 * The mock suite covers the screens in both languages. What this adds is
 * everything under them — the identifier normalised by `@helpdock/schemas`
 * before it reaches the unique index, the `contact_identities` row written in
 * the request's own transaction, the audit row beside it, and the 409 the index
 * produces when the same address is typed twice.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

const CONTACT_NAME = 'Mona Khalil';
const CONTACT_EMAIL = 'mona.khalil@example.com';

const openContacts = async (page: Page): Promise<void> => {
  await page.getByRole('link', { name: new RegExp(t('admin:nav.contacts')) }).click();
  await page.getByRole('heading', { name: t('contacts:title'), level: 1 }).waitFor();
};

test.describe('contacts against the real api', () => {
  test('creates a contact and opens it, with the address normalised on the way in', async ({
    page,
  }) => {
    await openAdmin(page);
    await openContacts(page);

    await expect(page.getByText(t('contacts:empty.heading'))).toBeVisible();

    await page.getByRole('button', { name: t('contacts:newContact') }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel(t('contacts:dialog.nameLabel'), { exact: true }).fill(CONTACT_NAME);
    await form
      .getByLabel(t('contacts:dialog.identityValueLabel'), { exact: true })
      .fill(CONTACT_EMAIL.toUpperCase());
    await form.getByRole('button', { name: t('contacts:dialog.createSubmit') }).click();

    await expect(page.getByText(t('contacts:toast.created', { name: CONTACT_NAME }))).toBeVisible();
    await expect(page.getByRole('heading', { name: CONTACT_NAME, level: 1 })).toBeVisible();
    await expect(
      page.getByText(`${CONTACT_EMAIL} ${t('contacts:identity.unverified')}`).first(),
    ).toBeVisible();
  });

  test('shows the new contact in the list and finds it by its address', async ({ page }) => {
    await openAdmin(page);
    await openContacts(page);

    await expect(page.getByRole('table').getByText(CONTACT_NAME)).toBeVisible();

    await page.getByLabel(t('contacts:searchPlaceholder'), { exact: true }).fill('mona.khalil@');
    await expect(page.getByRole('table').getByText(CONTACT_NAME)).toBeVisible();
  });

  test('refuses the same address a second time, from the unique index itself', async ({ page }) => {
    await openAdmin(page);
    await openContacts(page);

    await page.getByRole('button', { name: t('contacts:newContact') }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel(t('contacts:dialog.nameLabel'), { exact: true }).fill('Somebody else');
    await form
      .getByLabel(t('contacts:dialog.identityValueLabel'), { exact: true })
      .fill(CONTACT_EMAIL);
    await form.getByRole('button', { name: t('contacts:dialog.createSubmit') }).click();

    await expect(page.getByText(t('contacts:toast.identityTaken'))).toBeVisible();
  });

  test('adds a note to the contact and reads it back', async ({ page }) => {
    await openAdmin(page);
    await openContacts(page);
    await page.getByRole('link', { name: CONTACT_NAME, exact: true }).click();
    await page.getByRole('heading', { name: CONTACT_NAME, level: 1 }).waitFor();

    await page
      .getByLabel(t('contacts:detail.addNote'), { exact: true })
      .fill('Prefers a call before any billing change.');
    await page.getByRole('button', { name: t('contacts:detail.saveNote') }).click();

    await expect(page.getByText(t('contacts:toast.noteAdded'))).toBeVisible();
    await expect(page.getByText('Prefers a call before any billing change.')).toBeVisible();
  });
});
