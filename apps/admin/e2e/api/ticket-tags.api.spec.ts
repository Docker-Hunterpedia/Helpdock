import { expect, type Page, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';

/**
 * M1-15 against the real api: a tag put on a ticket, and taken off again, from
 * the details panel (artboard `Admin/Ticket-Tags`).
 *
 * The mock suite covers the tags row in both languages. What this adds is the
 * `PUT /tickets/:id/tags` replace underneath it — the `ticket_tags` rows
 * written under row-level security, the brand's tag looked up inside the same
 * transaction — read back over HTTP rather than from the screen that wrote it.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

/** Unique per run: tag names are unique per brand and these rows outlive a failed run. */
const RUN = String(Date.now()).slice(-6);
const TAG = `Warranty ${RUN}`;
const SUBJECT = `Hinge broke after a week ${RUN}`;

/** Signed in as the seeded install admin, through the second factor. */
const signInAsAdmin = async (page: Page): Promise<void> => {
  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(process.env[ACCOUNT_EMAIL_ENV] ?? '');
  await page
    .getByLabel(t('auth:signIn.passwordLabel'))
    .fill(process.env[ACCOUNT_PASSWORD_ENV] ?? '');
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();

  await page
    .getByLabel(t('auth:totp.codeLabel'))
    .fill(await generate({ secret: process.env[TOTP_SECRET_ENV] ?? '' }));
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
  await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();
};

/**
 * A bearer token and the brand to use it in. The app keeps its access token in
 * memory; the refresh cookie is in the browser context, which `page.request`
 * shares, so one refresh buys a token the api accepts.
 */
const apiSession = async (page: Page): Promise<{ token: string; brandId: string }> => {
  const refreshed = await page.request.post('/api/auth/refresh');
  expect(refreshed.ok()).toBe(true);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };

  const brands = await page.request.get('/api/brands', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(brands.ok()).toBe(true);
  const body = (await brands.json()) as { brands: { id: string }[] };

  return { token: accessToken, brandId: body.brands[0]?.id ?? '' };
};

/** The ticket's tags as the api stores them, by name. */
const storedTags = async (page: Page, ticketId: string): Promise<string[]> => {
  const { token, brandId } = await apiSession(page);
  const response = await page.request.get(`/api/brands/${brandId}/tickets/${ticketId}/tags`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { tags: { name: string }[] };

  return body.tags.map((tag) => tag.name);
};

test.describe('tagging a ticket against the real api', () => {
  test('puts a tag on from the picker and takes it off with its ×', async ({ page }) => {
    await signInAsAdmin(page);

    // The tag, made the way the Tags tab makes it: tags are configuration,
    // and the picker never creates one.
    const { token, brandId } = await apiSession(page);
    const created = await page.request.post(`/api/brands/${brandId}/tags`, {
      headers: { authorization: `Bearer ${token}` },
      data: { name: TAG, color: 'warning' },
    });
    expect(created.ok()).toBe(true);
    // The workspace read the brand's tags when sign-in landed on it; a reload
    // reads them again, as a colleague's new tag reaches a desk.
    await page.reload();
    await page.getByRole('navigation', { name: t('admin:nav.label') }).waitFor();

    await page
      .getByRole('link', { name: new RegExp(t('admin:nav.tickets')) })
      .first()
      .click();
    await page.getByRole('region', { name: t('tickets:list.label') }).waitFor();

    await page.getByRole('button', { name: t('tickets:newTicket.action') }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: t('tickets:newTicket.contactNone') }).click();
    await dialog.getByRole('textbox', { name: t('tickets:newTicket.subjectLabel') }).fill(SUBJECT);
    await dialog
      .getByRole('textbox', { name: t('tickets:newTicket.messageLabel') })
      .fill('The left hinge snapped.');
    await dialog.getByRole('button', { name: t('tickets:newTicket.submit') }).click();
    await expect(page.getByRole('heading', { name: SUBJECT, level: 1 })).toBeVisible();
    const ticketId = new URL(page.url()).pathname.split('/').at(-1) ?? '';

    const details = page.getByRole('complementary', { name: t('tickets:details.label') });
    await details.getByRole('button', { name: t('tickets:details.tagPicker.open') }).click();
    await page.getByRole('combobox', { name: t('tickets:details.tagPicker.search') }).fill(TAG);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: TAG })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    const remove = details.getByRole('button', {
      name: t('tickets:details.tagPicker.remove', { name: TAG }),
    });
    await expect(remove).toBeVisible();
    await expect.poll(() => storedTags(page, ticketId)).toEqual([TAG]);

    await remove.click();

    await expect(remove).toHaveCount(0);
    await expect.poll(() => storedTags(page, ticketId)).toEqual([]);
  });
});
