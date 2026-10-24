import type { Page } from '@playwright/test';
import { openSettingsArea, settingsTab } from '../flows.js';
import { strings } from '../strings.js';
import { expect, openAdmin, test } from './admin-session.js';
import {
  E2E_INSTAGRAM,
  E2E_MESSENGER,
  E2E_MESSENGER_RENEWED_TOKEN,
  E2E_META_APP_ID,
  E2E_OTHER_MESSENGER,
  E2E_REFUSED_META_DETAIL,
  E2E_REFUSED_META_TOKEN,
  E2E_WHATSAPP,
  E2E_WHATSAPP_PHONE,
  type E2eAccount,
  queueRefusal,
  revokeToken,
  subscriptionsUrl,
} from './fake-graph.js';
import { E2E_WEB_ORIGIN, SKIP_ENV } from './install.js';

/**
 * M10-07 against the real api, with a local stand-in for Graph: the install's
 * Meta app read from the environment and a verify token made and shown once;
 * a WhatsApp number, a Page and an Instagram account refused and then connected
 * through Graph's own answers, each subscribed; a Page whose token Meta
 * revoked reconnected with a new token for the same Page, and held to that Page;
 * an account's page tested, saved and subscribed again; and disconnected by its id.
 *
 * The mock suite covers the screens in both languages. What this adds is the
 * wiring under them — the token checked against the id before it is stored,
 * encrypted and shown only as its last four characters, Meta's words reaching
 * the dialog, the app subscribed and unsubscribed on Meta's side, and the
 * audit-logged disconnect.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

const openMeta = async (page: Page): Promise<void> => {
  await openAdmin(page);
  await openSettingsArea(page, t, 'channels');
  await settingsTab(page, t, 'channels:tabs.meta').click();
};

const accountsTable = (page: Page) => page.getByRole('table', { name: t('channels:meta.heading') });

const subscribedFields = async (account: E2eAccount): Promise<string[]> => {
  const response = await fetch(subscriptionsUrl(account));
  return ((await response.json()) as { fields: string[] }).fields;
};

test.describe('Channels › Meta against the real api', () => {
  test('shows the install’s Meta app and makes a verify token that is shown once', async ({
    page,
  }) => {
    await openMeta(page);
    await expect(
      page.getByRole('heading', { name: t('channels:meta.empty.heading') }),
    ).toBeVisible();

    const card = page.getByRole('region', { name: t('channels:meta.app.heading') });
    await expect(
      card.getByLabel(t('channels:meta.app.callback.label'), { exact: true }),
    ).toHaveValue(`${E2E_WEB_ORIGIN}/api/meta/webhook`);
    // The app id and the app secret are the environment's, which the card says.
    await expect(card.getByLabel(t('channels:meta.app.appId.label'))).toHaveValue(E2E_META_APP_ID);
    await expect(card.getByText(t('aiSettings:env.chip'))).toHaveCount(2);
    await expect(card.getByLabel(t('channels:meta.app.instagramSecret.label'))).toHaveValue(
      t('channels:meta.app.state.notSet'),
    );
    await expect(card.getByLabel(t('channels:meta.app.graphVersion.label'))).toHaveValue('v25.0');

    // The first read made a token; replacing it shows the new one once.
    await card.getByRole('button', { name: t('channels:meta.app.verify.replace') }).click();
    await page
      .getByRole('dialog', { name: t('channels:meta.app.verify.confirm.title') })
      .getByRole('button', { name: t('channels:meta.app.verify.confirm.action') })
      .click();
    const reveal = page.getByRole('dialog', { name: t('channels:meta.app.verify.reveal.title') });
    const shown = await reveal.getByLabel(t('channels:meta.app.verify.reveal.label')).inputValue();
    expect(shown).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await reveal.getByRole('button', { name: t('developers:done') }).click();

    await expect(
      card.getByLabel(t('channels:meta.app.verify.masked', { hint: shown.slice(-4) })),
    ).toBeVisible();
    await expect(page.getByText(shown)).toHaveCount(0);
  });

  test('refuses a token Meta does not know, then connects a number, a Page and an account', async ({
    page,
  }) => {
    await openMeta(page);
    await page
      .getByRole('button', { name: t('channels:meta.addAccount') })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: t('channels:meta.connect.title') });
    const connect = dialog.getByRole('button', { name: t('channels:meta.connect.submit') });
    const test = dialog.getByRole('button', { name: t('channels:meta.connect.test') });

    // ------------------------------------------------------------ WhatsApp
    await dialog.getByLabel(t('channels:meta.connect.id.whatsapp')).fill(E2E_WHATSAPP.id);
    await dialog.getByLabel(t('channels:meta.connect.token')).fill(E2E_REFUSED_META_TOKEN);
    await test.click();
    await expect(
      dialog.getByText(
        t('channels:meta.connect.refused', { detail: `190: ${E2E_REFUSED_META_DETAIL}` }),
      ),
    ).toBeVisible();
    await expect(connect).toBeDisabled();

    // The token reads the number, but no business account it was granted on lists it.
    await queueRefusal({
      status: 403,
      code: 200,
      message: '(#200) Requires whatsapp_business_management permission',
      match: 'phone_numbers',
    });
    await dialog.getByLabel(t('channels:meta.connect.token')).fill(E2E_WHATSAPP.token);
    await test.click();
    await expect(dialog.getByText(t('channels:meta.refusal.token-other-account'))).toBeVisible();
    await expect(connect).toBeDisabled();

    await test.click();
    await expect(dialog.getByRole('status')).toContainText(E2E_WHATSAPP.name);
    await connect.click();
    await expect(dialog).toBeHidden();

    const whatsapp = accountsTable(page).getByRole('row').filter({ hasText: E2E_WHATSAPP_PHONE });
    await expect(whatsapp).toContainText(t('channels:meta.subscription.subscribed'));
    await expect(whatsapp).toContainText(t('channels:meta.health.waiting'));
    // Meta keeps a number's subscription on its business account; the stand-in
    // refuses the number's own edge, so this proves the api went there.
    expect(await subscribedFields(E2E_WHATSAPP)).toEqual(['messages']);

    // ------------------------------------------------- taken, then Messenger
    await page.getByRole('button', { name: t('channels:meta.addAccount') }).click();
    await dialog.getByLabel(t('channels:meta.connect.id.whatsapp')).fill(E2E_WHATSAPP.id);
    await dialog.getByLabel(t('channels:meta.connect.token')).fill(E2E_WHATSAPP.token);
    await test.click();
    await expect(dialog.getByText(t('channels:meta.refusal.account-taken'))).toBeVisible();
    await expect(connect).toBeDisabled();

    await dialog
      .getByRole('radio', { name: new RegExp(t('channels:meta.platforms.messenger')) })
      .check();
    await dialog.getByLabel(t('channels:meta.connect.id.messenger')).fill(E2E_MESSENGER.id);
    await dialog.getByLabel(t('channels:meta.connect.token')).fill(E2E_MESSENGER.token);
    await test.click();
    await expect(dialog.getByRole('status')).toContainText(E2E_MESSENGER.name);
    await connect.click();
    await expect(dialog).toBeHidden();
    await expect(
      accountsTable(page).getByRole('link', { name: E2E_MESSENGER.name, exact: true }),
    ).toBeVisible();
    expect(await subscribedFields(E2E_MESSENGER)).toContain('message_echoes');

    // ----------------------------------------------- Instagram, wrong token
    await page.getByRole('button', { name: t('channels:meta.addAccount') }).click();
    await dialog
      .getByRole('radio', { name: new RegExp(t('channels:meta.platforms.instagram')) })
      .check();
    await dialog.getByLabel(t('channels:meta.connect.id.instagram')).fill(E2E_INSTAGRAM.id);
    await dialog.getByLabel(t('channels:meta.connect.token')).fill(E2E_MESSENGER.token);
    await test.click();
    await expect(dialog.getByText(t('channels:meta.refusal.platform-mismatch'))).toBeVisible();

    await dialog.getByLabel(t('channels:meta.connect.token')).fill(E2E_INSTAGRAM.token);
    await test.click();
    await expect(dialog.getByRole('status')).toContainText(`@${E2E_INSTAGRAM.username}`);
    await connect.click();
    await expect(dialog).toBeHidden();
    await expect(
      accountsTable(page).getByRole('link', { name: `@${E2E_INSTAGRAM.username}` }),
    ).toBeVisible();
    expect(await subscribedFields(E2E_INSTAGRAM)).toContain('messaging_seen');
  });

  test('reconnects a Page whose token Meta revoked with a token for the same Page, and no other', async ({
    page,
  }) => {
    await openMeta(page);
    await accountsTable(page).getByRole('link', { name: E2E_MESSENGER.name, exact: true }).click();
    const form = page.getByRole('form', { name: E2E_MESSENGER.name });

    // Meta revokes the token; the next time the app is subscribed, Meta says so and the
    // account is marked, which is when the page offers Reconnect.
    await revokeToken(E2E_MESSENGER.token);
    await form.getByRole('button', { name: t('channels:meta.detail.subscription.button') }).click();
    const reconnect = form.getByRole('button', {
      name: t('channels:meta.detail.connection.reconnect'),
    });
    await expect(reconnect).toBeVisible();
    await reconnect.click();
    const dialog = page.getByRole('dialog', {
      name: t('channels:meta.reconnect.title', { name: E2E_MESSENGER.name }),
    });
    const token = dialog.getByLabel(new RegExp(`^${t('channels:meta.connect.token')}`));
    const test = dialog.getByRole('button', { name: t('channels:meta.connect.test') });
    const submit = dialog.getByRole('button', { name: t('channels:meta.reconnect.submit') });

    // The revoked token is refused in Meta's words.
    await token.fill(E2E_MESSENGER.token);
    await test.click();
    await expect(dialog.getByText(/Meta refused this token/)).toBeVisible();
    await expect(submit).toBeDisabled();

    // Another Page's token is a good token, but not for this Page.
    await token.fill(E2E_OTHER_MESSENGER.token);
    await test.click();
    await expect(dialog.getByText(t('channels:meta.refusal.token-other-account'))).toBeVisible();
    await expect(submit).toBeDisabled();

    // A new token for this Page tests well, though the Page's id is already connected:
    // the api is told which account the replacement is for.
    await token.fill(E2E_MESSENGER_RENEWED_TOKEN);
    await test.click();
    await expect(dialog.getByRole('status')).toContainText(E2E_MESSENGER.name);
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(
      page.getByText(t('channels:meta.toast.reconnected', { name: E2E_MESSENGER.name })),
    ).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(reconnect).toHaveCount(0);
    await expect(
      form.getByLabel(
        t('channels:meta.detail.connection.masked', {
          hint: E2E_MESSENGER_RENEWED_TOKEN.slice(-4),
        }),
      ),
    ).toBeVisible();
    await expect(page.getByText(E2E_MESSENGER_RENEWED_TOKEN)).toHaveCount(0);

    // Connecting the same id as a new account is still refused: only a reconnect may reuse it.
    await openMeta(page);
    await page.getByRole('button', { name: t('channels:meta.addAccount') }).click();
    const connectDialog = page.getByRole('dialog', { name: t('channels:meta.connect.title') });
    await connectDialog
      .getByRole('radio', { name: new RegExp(t('channels:meta.platforms.messenger')) })
      .check();
    await connectDialog.getByLabel(t('channels:meta.connect.id.messenger')).fill(E2E_MESSENGER.id);
    await connectDialog
      .getByLabel(t('channels:meta.connect.token'))
      .fill(E2E_MESSENGER_RENEWED_TOKEN);
    await connectDialog.getByRole('button', { name: t('channels:meta.connect.test') }).click();
    await expect(connectDialog.getByText(t('channels:meta.refusal.account-taken'))).toBeVisible();
    await connectDialog.getByRole('button', { name: t('common:actions.cancel') }).click();
  });

  test('tests a Page, saves its Human Agent switch, subscribes it again and disconnects it by its id', async ({
    page,
  }) => {
    await openMeta(page);
    await accountsTable(page).getByRole('link', { name: E2E_MESSENGER.name, exact: true }).click();
    const form = page.getByRole('form', { name: E2E_MESSENGER.name });
    // Encrypted at rest and shown as its last four characters.
    await expect(
      form.getByLabel(
        t('channels:meta.detail.connection.masked', {
          hint: E2E_MESSENGER_RENEWED_TOKEN.slice(-4),
        }),
      ),
    ).toHaveValue(`•••• ${E2E_MESSENGER_RENEWED_TOKEN.slice(-4)}`);
    await expect(page.getByText(E2E_MESSENGER_RENEWED_TOKEN)).toHaveCount(0);

    await form.getByRole('button', { name: t('channels:meta.detail.connection.test') }).click();
    await expect(form.getByRole('status').first()).toContainText(E2E_MESSENGER.id);

    const humanAgent = form.getByRole('switch', {
      name: t('channels:meta.detail.humanAgent.switch'),
    });
    await humanAgent.click();
    await form.getByRole('button', { name: t('channels:meta.detail.footer.save') }).click();
    await expect(
      page.getByText(t('channels:meta.toast.saved', { name: E2E_MESSENGER.name })),
    ).toBeVisible();
    await expect(humanAgent).toHaveAttribute('aria-checked', 'true');

    await form.getByRole('button', { name: t('channels:meta.detail.subscription.button') }).click();
    await expect(
      page.getByText(t('channels:meta.toast.subscribed', { name: E2E_MESSENGER.name })),
    ).toBeVisible();
    await expect(form.getByText('message_reads')).toBeVisible();

    await page.getByRole('button', { name: t('channels:meta.detail.danger.action') }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', {
      name: t('channels:meta.disconnectConfirm.action'),
    });
    await dialog.getByRole('textbox').fill(E2E_MESSENGER.id.slice(0, 8));
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill(E2E_MESSENGER.id);
    await confirm.click();

    await expect(
      page.getByText(t('channels:meta.toast.disconnected', { name: E2E_MESSENGER.name })),
    ).toBeVisible();
    await expect(
      accountsTable(page).getByRole('link', { name: E2E_MESSENGER.name, exact: true }),
    ).toHaveCount(0);
    // Meta no longer posts for it, and the others are untouched.
    expect(await subscribedFields(E2E_MESSENGER)).toEqual([]);
    expect(await subscribedFields(E2E_WHATSAPP)).toEqual(['messages']);
  });

  test('disconnects the last two accounts and shows the empty state again', async ({ page }) => {
    await openMeta(page);

    for (const account of [E2E_WHATSAPP, E2E_INSTAGRAM]) {
      const name = account.platform === 'instagram' ? `@${account.username}` : E2E_WHATSAPP_PHONE;
      await accountsTable(page).getByRole('link', { name, exact: true }).click();
      await page.getByRole('button', { name: t('channels:meta.detail.danger.action') }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox').fill(account.id);
      await dialog
        .getByRole('button', { name: t('channels:meta.disconnectConfirm.action') })
        .click();
      await expect(page.getByText(t('channels:meta.toast.disconnected', { name }))).toBeVisible();
      expect(await subscribedFields(account)).toEqual([]);
    }

    await expect(
      page.getByRole('heading', { name: t('channels:meta.empty.heading') }),
    ).toBeVisible();
  });
});
