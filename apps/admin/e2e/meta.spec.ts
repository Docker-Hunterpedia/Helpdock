import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  MOCK_INSTAGRAM_TOKEN,
  MOCK_MESSENGER_TOKEN,
  MOCK_NEW_INSTAGRAM_ID,
  MOCK_NEW_MESSENGER_PAGE_ID,
  MOCK_NEW_WHATSAPP_PHONE_ID,
  MOCK_REFUSED_TOKEN,
  MOCK_WHATSAPP_TOKEN,
} from '../src/meta/mock-api.js';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M10-07 in a real browser, in both languages: Channels › Meta
 * (`Admin/Channels-Meta`, `Admin/Channels-Meta-Account`) — the app card and the
 * list, Connect with a refused token and then a good one for each platform, an
 * account's page with Test connection, the Human Agent switch and Save,
 * Reconnect for a token Meta invalidated, and Disconnect by the account's id.
 *
 * Every step navigates by clicking, never by `page.goto`: the fixture keeps
 * its session and its data in memory, and a reload would lose both.
 */

test.use({ reducedMotion: 'reduce' });

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

const openMeta = async (page: Page, locale: 'en' | 'ar'): Promise<void> => {
  const t = strings(locale);
  await page.getByRole('link', { name: new RegExp(t('admin:nav.channels')) }).click();
  await page.getByRole('tab', { name: t('channels:tabs.meta') }).click();
  await page
    .getByRole('table', { name: t('channels:meta.heading') })
    .getByRole('link', { name: '+1 555 0142' })
    .waitFor();
};

test.describe('Channels › Meta', () => {
  test('lists the accounts with their health and the install’s Meta app', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMeta(page, locale);

    const accounts = page.getByRole('table', { name: t('channels:meta.heading') });
    const expired = accounts.getByRole('row').filter({ hasText: '@helpdock' });
    await expect(expired).toContainText(t('channels:meta.health.tokenExpired'));
    await expect(
      expired.getByRole('link', { name: t('channels:meta.health.fixFor', { name: '@helpdock' }) }),
    ).toBeVisible();
    await expect(accounts.getByRole('row').filter({ hasText: '+1 555 0100' })).toContainText(
      t('channels:meta.noEvent'),
    );

    const card = page.getByRole('region', { name: t('channels:meta.app.heading') });
    await expect(
      card.getByLabel(t('channels:meta.app.callback.label'), { exact: true }),
    ).toHaveValue('https://support.helpdock.io/api/meta/webhook');
    await expect(card.getByText(t('aiSettings:env.chip'))).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('makes a new verify token after a confirmation and shows it once', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMeta(page, locale);

    const card = page.getByRole('region', { name: t('channels:meta.app.heading') });
    await card.getByRole('button', { name: t('channels:meta.app.verify.replace') }).click();
    await page
      .getByRole('dialog', { name: t('channels:meta.app.verify.confirm.title') })
      .getByRole('button', { name: t('channels:meta.app.verify.confirm.action') })
      .click();

    const reveal = page.getByRole('dialog', { name: t('channels:meta.app.verify.reveal.title') });
    await expect(reveal.getByText(t('channels:meta.app.verify.reveal.strong'))).toBeVisible();
    await expect(reveal.getByLabel(t('channels:meta.app.verify.reveal.label'))).toHaveValue(
      /^hd_mvt_/,
    );
    expect(await violations(page)).toEqual([]);

    await reveal.getByRole('button', { name: t('developers:done') }).click();
    await expect(reveal).toBeHidden();
  });

  test('refuses a token Meta does not know, then connects an account of each platform', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMeta(page, locale);

    const platforms = [
      {
        platform: 'whatsapp',
        id: MOCK_NEW_WHATSAPP_PHONE_ID,
        token: MOCK_WHATSAPP_TOKEN,
        listed: '+1 555 8204',
      },
      {
        platform: 'messenger',
        id: MOCK_NEW_MESSENGER_PAGE_ID,
        token: MOCK_MESSENGER_TOKEN,
        listed: 'Helpdock 0111',
      },
      {
        platform: 'instagram',
        id: MOCK_NEW_INSTAGRAM_ID,
        token: MOCK_INSTAGRAM_TOKEN,
        listed: '@helpdock_0111',
      },
    ] as const;

    for (const [index, { platform, id, token, listed }] of platforms.entries()) {
      await page.getByRole('button', { name: t('channels:meta.addAccount') }).click();
      const dialog = page.getByRole('dialog', { name: t('channels:meta.connect.title') });
      const connect = dialog.getByRole('button', { name: t('channels:meta.connect.submit') });
      await dialog
        .getByRole('radio', { name: new RegExp(t(`channels:meta.platforms.${platform}`)) })
        .check();
      await expect(connect).toBeDisabled();

      await dialog.getByLabel(t(`channels:meta.connect.id.${platform}`)).fill(id);
      if (index === 0) {
        await dialog.getByLabel(t('channels:meta.connect.token')).fill(MOCK_REFUSED_TOKEN);
        await dialog.getByRole('button', { name: t('channels:meta.connect.test') }).click();
        await expect(
          dialog.getByText(
            t('channels:meta.connect.refused', {
              detail: 'Invalid OAuth access token - Cannot parse access token (190)',
            }),
          ),
        ).toBeVisible();
        await expect(dialog.getByLabel(t('channels:meta.connect.token'))).toHaveAttribute(
          'aria-invalid',
          'true',
        );
        await expect(connect).toBeDisabled();
        expect(await violations(page)).toEqual([]);
      }

      await dialog.getByLabel(t('channels:meta.connect.token')).fill(token);
      await dialog.getByRole('button', { name: t('channels:meta.connect.test') }).click();
      await expect(dialog.getByRole('status')).toContainText(t('channels:meta.connect.works'));
      if (platform !== 'whatsapp') {
        await expect(dialog.getByRole('note')).toBeVisible();
      }
      await connect.click();

      await expect(dialog).toBeHidden();
      await expect(
        page
          .getByRole('table', { name: t('channels:meta.heading') })
          .getByRole('link', { name: listed }),
      ).toBeVisible();
    }
  });

  test('tests a Page’s connection, saves Human Agent, and disconnects it by its id', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMeta(page, locale);

    await page
      .getByRole('table', { name: t('channels:meta.heading') })
      .getByRole('link', { name: 'Helpdock', exact: true })
      .click();
    const form = page.getByRole('form', { name: 'Helpdock' });
    await expect(
      form.getByLabel(t('channels:meta.detail.connection.masked', { hint: '8KQZ' })),
    ).toHaveValue('•••• 8KQZ');
    await expect(
      form.getByRole('button', { name: t('channels:meta.detail.footer.save') }),
    ).toBeDisabled();
    expect(await violations(page)).toEqual([]);

    await form.getByRole('button', { name: t('channels:meta.detail.connection.test') }).click();
    await expect(form.getByRole('status').first()).toContainText('Helpdock');

    await form.getByRole('switch', { name: t('channels:meta.detail.humanAgent.switch') }).click();
    await form.getByRole('button', { name: t('channels:meta.detail.footer.save') }).click();
    await expect(
      page.getByText(t('channels:meta.toast.saved', { name: 'Helpdock' })),
    ).toBeVisible();
    await expect(
      form.getByRole('switch', { name: t('channels:meta.detail.humanAgent.switch') }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('channels:meta.detail.danger.action') }).click();
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', {
      name: t('channels:meta.disconnectConfirm.action'),
    });
    await dialog.getByRole('textbox').fill('104857223');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('textbox').fill('104857223916604');
    await confirm.click();

    await expect(
      page.getByText(t('channels:meta.toast.disconnected', { name: 'Helpdock' })),
    ).toBeVisible();
    await expect(
      page
        .getByRole('table', { name: t('channels:meta.heading') })
        .getByRole('link', { name: 'Helpdock', exact: true }),
    ).toHaveCount(0);
  });

  test('has no Human Agent on a WhatsApp number, and says what Meta charges', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMeta(page, locale);

    await page
      .getByRole('table', { name: t('channels:meta.heading') })
      .getByRole('link', { name: '+1 555 0142' })
      .click();
    const form = page.getByRole('form', { name: '+1 555 0142' });
    await expect(form.getByText(t('channels:meta.detail.number.chargeLead'))).toBeVisible();
    await expect(form.getByRole('switch')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  test('reconnects an account whose token Meta invalidated', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openMeta(page, locale);

    await page
      .getByRole('table', { name: t('channels:meta.heading') })
      .getByRole('link', { name: '@helpdock', exact: true })
      .click();
    const form = page.getByRole('form', { name: '@helpdock' });
    await expect(form.getByRole('alert')).toContainText(/Error validating access token/);
    expect(await violations(page)).toEqual([]);

    await form
      .getByRole('button', { name: t('channels:meta.detail.connection.reconnect') })
      .click();
    const dialog = page.getByRole('dialog', {
      name: t('channels:meta.reconnect.title', { name: '@helpdock' }),
    });
    const reconnect = dialog.getByRole('button', { name: t('channels:meta.reconnect.submit') });
    await expect(reconnect).toBeDisabled();
    await dialog.getByLabel(t('channels:meta.connect.token')).fill(MOCK_INSTAGRAM_TOKEN);
    await dialog.getByRole('button', { name: t('channels:meta.connect.test') }).click();
    await expect(dialog.getByRole('status')).toContainText(t('channels:meta.connect.works'));
    expect(await violations(page)).toEqual([]);
    await reconnect.click();

    await expect(
      page.getByText(t('channels:meta.toast.reconnected', { name: '@helpdock' })),
    ).toBeVisible();
    await expect(
      form.getByRole('button', { name: t('channels:meta.detail.connection.reconnect') }),
    ).toHaveCount(0);
  });
});
