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
import { openSettingsArea, openTicket, settingsTab, signIn } from './flows.js';
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
 *
 * M10-08 adds the ticket (`Admin/Ticket-Meta`): a WhatsApp ticket with its
 * window open, a Messenger ticket in the Human Agent days, an Instagram ticket
 * whose window has closed, and the refusal a send gets when the window closed
 * while the agent was writing.
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
  await openSettingsArea(page, t, 'channels');
  await settingsTab(page, t, 'channels:tabs.meta').click();
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

/**
 * The three Meta tickets of the fixture, as `Admin/Ticket-Meta` draws them:
 * HD-1040 on WhatsApp (the customer wrote 66 minutes ago), HD-1038 on Messenger
 * (30 hours ago, the Human Agent switch on) and HD-1036 on Instagram (8 days ago).
 * The windows are measured from when the page loads, so they hold on any day.
 */
test.describe('the ticket', () => {
  const strip = (page: Page) => page.getByRole('status').filter({ has: page.locator('time') });
  const thread = (page: Page, locale: 'en' | 'ar') =>
    page.getByRole('list', { name: strings(locale)('tickets:thread.label') });
  const composer = (page: Page, locale: 'en' | 'ar') =>
    page.getByRole('form', { name: strings(locale)('tickets:composer.label') });

  test('an open window: names the number, says the time left, counts the messages and sends', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1040');

    const header = page.getByRole('region', { name: t('tickets:header.label') });
    await expect(header).toContainText('+1 555 0142');
    await expect(header).toContainText(t('tickets:channel.whatsapp'));

    await expect(strip(page)).toContainText(
      t('tickets:meta.window.caption', { platform: t('tickets:channel.whatsapp') }),
    );
    await expect(strip(page).locator('time')).toBeVisible();
    // The strip arrives after the thread was scrolled to its last reply, and
    // takes room from it: the reply must still end above the strip.
    const lastReply = thread(page, locale).getByRole('article').last();
    await expect
      .poll(async () => {
        const reply = await lastReply.boundingBox();
        const bar = await strip(page).boundingBox();
        return reply !== null && bar !== null && reply.y + reply.height <= bar.y + 1;
      })
      .toBe(true);

    const identity = page.getByRole('region', {
      name: t('tickets:meta.identity.heading.whatsapp'),
    });
    await expect(identity).toContainText('US.13491208655302741918');
    await expect(identity).toContainText('+44 7700 900123');
    await expect(
      identity.getByRole('button', { name: t('tickets:meta.identity.copyUserId') }),
    ).toBeVisible();

    const messages = thread(page, locale);
    // Each reply's accessible name carries where it stands.
    for (const state of ['read', 'delivered', 'sent', 'queued'] as const) {
      await expect(
        messages.getByRole('article', {
          name: t('tickets:meta.replyLabel', {
            name: 'Lina Haddad',
            state: t(`tickets:meta.state.${state}`),
          }),
        }),
      ).toBeVisible();
    }
    expect(await violations(page)).toEqual([]);

    const form = composer(page, locale);
    await expect(form).toContainText('+44 7700 900123');
    await form
      .getByRole('textbox', { name: t('tickets:composer.bodyLabel') })
      .fill('Thanks, Daniel.');
    await expect(form).toContainText(t('tickets:meta.composer.plain'));
    const send = form.getByRole('button', { name: t('tickets:composer.send') });
    await expect(send).not.toHaveAttribute('aria-disabled', 'true');
    await send.click();

    await expect(messages.getByText('Thanks, Daniel.', { exact: true })).toBeVisible();
  });

  test('a reply refused because the window had closed says so, and offers no Retry', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1040');

    const messages = thread(page, locale);
    const refused = messages.getByText(t('tickets:meta.refused'), { exact: true });
    await expect(refused).toBeVisible();
    await expect(refused.locator('..')).toContainText('131047');
    await expect(messages.getByText(t('tickets:meta.refusedNoRetry'))).toBeVisible();
    await expect(
      messages.getByRole('button', {
        name: t('tickets:meta.retryLabel', { channel: t('tickets:channel.whatsapp') }),
      }),
    ).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  test('the Human Agent days: leaves Send on, and retries the part Messenger refused', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1038');

    await expect(strip(page)).toContainText(
      t('tickets:meta.window.captionHumanAgent', { platform: t('tickets:channel.messenger') }),
    );
    const form = composer(page, locale);
    await form
      .getByRole('textbox', { name: t('tickets:composer.bodyLabel') })
      .fill('Anything else?');
    await expect(
      form.getByRole('button', { name: t('tickets:composer.send') }),
    ).not.toHaveAttribute('aria-disabled', 'true');

    const messages = thread(page, locale);
    const failure = messages.getByText(t('tickets:meta.notDelivered'), { exact: true });
    await expect(failure).toBeVisible();
    await expect(failure.locator('..')).toContainText('1200');
    expect(await violations(page)).toEqual([]);

    await messages
      .getByRole('button', {
        name: t('tickets:meta.retryLabel', { channel: t('tickets:channel.messenger') }),
      })
      .click();
    await expect(page.getByText(t('tickets:meta.retried'))).toBeVisible();
    await expect(failure).toHaveCount(0);
  });

  test('a closed window: holds Send and says why, never refuses a note, and marks what was unsent', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1036');

    const closed = strip(page);
    await expect(closed).toContainText(
      t('tickets:meta.window.rule', {
        platform: t('tickets:channel.instagram'),
        name: 'Sara M.',
      }),
    );
    const form = composer(page, locale);
    const body = form.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
    const send = form.getByRole('button', { name: t('tickets:composer.send') });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAttribute('aria-describedby', (await closed.getAttribute('id')) ?? '');

    await body.fill('Hello Sara');
    // Held, not disabled: a click lands and does nothing.
    await send.click({ force: true });
    await expect(body).toHaveValue('Hello Sara');
    await expect(thread(page, locale).getByText('Hello Sara')).toHaveCount(0);

    const messages = thread(page, locale);
    await expect(messages.getByText('Replied to your story')).toBeVisible();
    await expect(messages.getByText(t('tickets:meta.unsent'))).toBeVisible();
    await expect(
      messages.getByText(
        t('tickets:meta.leftOutReason.pdfOnly', { platform: t('tickets:channel.instagram') }),
      ),
    ).toBeVisible();
    expect(await violations(page)).toEqual([]);

    await form.getByRole('button', { name: t('tickets:composer.note') }).click();
    await body.fill('Sara asked twice.');
    const add = form.getByRole('button', { name: t('tickets:composer.sendNote') });
    await expect(add).not.toHaveAttribute('aria-disabled', 'true');
    await add.click();
    await expect(messages.getByText('Sara asked twice.')).toBeVisible();
  });

  test('the window closing while the agent writes: the api refuses, the strip says so, the text stays', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    // Fake time that still flows, so a jump forward is the only thing that closes the window.
    await page.clock.install();
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1040');

    const form = composer(page, locale);
    const body = form.getByRole('textbox', { name: t('tickets:composer.bodyLabel') });
    await body.fill('Can we rebook?');
    await expect(strip(page)).toContainText(
      t('tickets:meta.window.caption', { platform: t('tickets:channel.whatsapp') }),
    );

    // The strip ticks once a minute, so for a moment it still says open.
    await page.clock.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    await form.getByRole('button', { name: t('tickets:composer.send') }).click();

    const refused = page.getByRole('status').filter({
      hasText: t('tickets:meta.window.rule', {
        platform: t('tickets:channel.whatsapp'),
        name: 'Daniel Reyes',
      }),
    });
    await expect(refused).toBeVisible();
    await expect(refused.locator('time')).toHaveCount(2);
    await expect(body).toHaveValue('Can we rebook?');
    const send = form.getByRole('button', { name: t('tickets:composer.send') });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAttribute(
      'aria-describedby',
      (await refused.getAttribute('id')) ?? '',
    );
    // Nothing was written, so there is no bubble to retry.
    await expect(thread(page, locale).getByText('Can we rebook?', { exact: true })).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });

  test('the countdown moves once a minute', async ({ page, appLocale: locale }) => {
    await page.clock.install();
    await signIn(page, locale);
    await openTicket(page, locale, 'HD-1040');

    const minutesLeft = async (): Promise<number> => {
      const text = (await strip(page).textContent()) ?? '';
      const found = /(\d+)h (\d+)m/.exec(text);
      return found === null ? Number.NaN : Number(found[1]) * 60 + Number(found[2]);
    };
    const before = await minutesLeft();
    expect(before).toBeGreaterThan(22 * 60);

    await page.clock.fastForward('01:00');

    await expect.poll(minutesLeft).toBeLessThan(before);
  });
});
