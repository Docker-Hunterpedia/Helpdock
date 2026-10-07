import { strings } from '../strings.js';
import { expect, openAdmin, test } from './admin-session.js';
import { E2E_BOT_TOKEN, E2E_BOT_USERNAME, E2E_REFUSED_TOKEN } from './fake-telegram.js';
import { SKIP_ENV } from './install.js';

/**
 * M6-05 against the real api, with a local stand-in for api.telegram.org: a
 * bot refused and then added through `getMe`, its webhook registered, its page
 * tested and saved, and the bot deleted.
 *
 * The mock suite covers the screen in both languages. What this adds is the
 * wiring under it — the token checked before it is stored, encrypted and
 * shown only as its last four characters, Telegram's refusal reaching the
 * dialog in Telegram's words, and the audit-logged delete.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

test.describe('Channels › Telegram against the real api', () => {
  test('refuses a token, adds a bot, tests and saves it, and deletes it', async ({ page }) => {
    await openAdmin(page);
    await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
    await page.getByRole('tab', { name: t('channels:tabs.telegram') }).click();
    await expect(
      page.getByRole('heading', { name: t('channels:telegram.empty.heading') }),
    ).toBeVisible();

    // ------------------------------------------------------------- add
    await page
      .getByRole('button', { name: t('channels:addBot') })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: t('channels:telegram.add.title') });
    const token = dialog.getByLabel(t('channels:telegram.add.token'));
    const test = dialog.getByRole('button', { name: t('channels:telegram.add.test') });

    await token.fill(E2E_REFUSED_TOKEN);
    await test.click();
    await expect(
      dialog.getByText(t('channels:telegram.add.refused', { detail: '401: Unauthorized' })),
    ).toBeVisible();

    await token.fill(E2E_BOT_TOKEN);
    await test.click();
    await expect(dialog.getByRole('status')).toContainText(`@${E2E_BOT_USERNAME}`);
    await dialog.getByRole('button', { name: t('channels:telegram.add.submit') }).click();

    const bots = page.getByRole('table', { name: t('channels:telegram.heading') });
    const row = bots.getByRole('row').filter({ hasText: E2E_BOT_USERNAME });
    await expect(row).toContainText(t('channels:telegram.health.waiting'));
    await expect(row).toContainText(t('channels:telegram.webhook.set'));

    // ------------------------------------------------------------ page
    await row.getByRole('link', { name: `@${E2E_BOT_USERNAME}`, exact: true }).click();
    const form = page.getByRole('form', { name: `@${E2E_BOT_USERNAME}` });
    await expect(
      form.getByLabel(
        t('channels:telegram.detail.connection.masked', { hint: E2E_BOT_TOKEN.slice(-4) }),
      ),
    ).toBeVisible();
    await form.getByRole('button', { name: t('channels:telegram.detail.connection.test') }).click();
    await expect(form.getByRole('status')).toContainText(`@${E2E_BOT_USERNAME}`);

    await form.getByLabel(t('channels:telegram.detail.welcome.en')).fill('Welcome to the desk.');
    await form.getByRole('button', { name: t('channels:telegram.detail.footer.save') }).click();
    await expect(
      page.getByText(t('channels:telegram.toast.saved', { username: E2E_BOT_USERNAME })),
    ).toBeVisible();

    // ---------------------------------------------------------- delete
    await page.getByRole('button', { name: t('channels:telegram.detail.danger.action') }).click();
    const confirm = page.getByRole('dialog');
    await confirm.getByRole('textbox').fill(`@${E2E_BOT_USERNAME}`);
    await confirm
      .getByRole('button', { name: t('channels:telegram.deleteConfirm.action') })
      .click();

    await expect(
      page.getByRole('heading', { name: t('channels:telegram.empty.heading') }),
    ).toBeVisible();
  });
});
