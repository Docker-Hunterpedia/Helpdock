import { expect, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';

/**
 * M1-06 against the real api: a tag, a custom field and a ticket template made
 * through the screens, and then a ticket created **from** that template through
 * the api the screens talk to.
 *
 * The mock suite covers the three tabs in both languages. What this adds is
 * everything under them — the rows written through row-level security inside
 * one request transaction, the unique index on `lower(name)`, the jsonb
 * validation built from the brand's own definitions, the placeholder renderer,
 * and the `ticket_tags` row the template's default tag leaves behind.
 *
 * The ticket is created over HTTP rather than through a screen because the
 * ticket workspace is M1-15's; the contract is what M1-06 owns, and this is
 * where it is exercised end to end.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

/** Unique per run: these rows outlive a failed run, and names are unique per brand. */
const RUN = String(Date.now()).slice(-6);
const TAG = `Chargeback ${RUN}`;
const FIELD_LABEL = `Plan tier ${RUN}`;
const FIELD_KEY = `plan_tier_${RUN}`;
const TEMPLATE = `Refund request ${RUN}`;

/** Signed in as the seeded install admin, through the second factor. */
const signInAsAdmin = async (page: import('@playwright/test').Page): Promise<void> => {
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

const ADD_BUTTON = {
  tags: t('ticketing:tags.add'),
  customFields: t('ticketing:customFields.addTo', {
    target: t('ticketing:customFields.targets.ticket').toLocaleLowerCase(),
  }),
  templates: t('ticketing:templates.add'),
} as const;

/**
 * Waits for a control only the destination tab has: the tab being left already
 * has a table, so waiting for "a table" would return before the switch.
 */
const openTab = async (
  page: import('@playwright/test').Page,
  tab: 'tags' | 'customFields' | 'templates',
): Promise<void> => {
  await page.getByRole('link', { name: new RegExp(t('admin:nav.ticketing')) }).click();
  await page.getByRole('table').first().waitFor();
  await page.getByRole('tab', { name: t(`ticketing:tabs.${tab}`) }).click();
  await page.getByRole('button', { name: ADD_BUTTON[tab], exact: true }).waitFor();
};

/**
 * A bearer token and the brand to use it in.
 *
 * The app keeps its access token in memory, so a spec cannot read it. The
 * refresh cookie is in the browser context, and `page.request` shares it, so
 * one refresh buys a token the api accepts — the same exchange the app makes
 * every ten minutes.
 */
const apiSession = async (
  page: import('@playwright/test').Page,
): Promise<{ token: string; brandId: string }> => {
  const refreshed = await page.request.post('/api/auth/refresh');
  expect(refreshed.ok()).toBe(true);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };

  const brands = await page.request.get('/api/brands', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(brands.ok()).toBe(true);
  const body = (await brands.json()) as { brands: { id: string }[] };
  const brandId = body.brands[0]?.id ?? '';
  expect(brandId).not.toBe('');

  return { token: accessToken, brandId };
};

test.describe('M1-06 against the real api', () => {
  test('creates a tag, which then appears in the list', async ({ page }) => {
    await signInAsAdmin(page);
    await openTab(page, 'tags');

    await page.getByRole('button', { name: t('ticketing:tags.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:tags.editor.name'), exact: true })
      .fill(TAG);
    await page
      .getByRole('radio', {
        name: t('ticketing:tags.editor.colourOption', {
          colour: t('ticketing:tags.colours.escalated'),
        }),
      })
      .check();
    await page
      .getByRole('button', { name: t('ticketing:tags.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.tagCreated', { name: TAG }),
    );

    // A second read from the server, which is the only thing that proves a row.
    // The reload lands back on this tab — the url names it — so there is no
    // navigation to repeat, only a row to wait for.
    await page.reload();
    await expect(
      page.getByRole('button', { name: t('ticketing:tags.table.select', { name: TAG }) }),
    ).toBeVisible();

    // And the unique index on `lower(name)` refuses the same name in another
    // case. Asserted here rather than in a test of its own: every sign-in costs
    // a fresh authenticator code, and this file is already serial.
    await page.getByRole('button', { name: t('ticketing:tags.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:tags.editor.name'), exact: true })
      .fill(TAG.toUpperCase());
    await page
      .getByRole('button', { name: t('ticketing:tags.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.nameTaken'));
  });

  test('creates a select custom field on the ticket', async ({ page }) => {
    await signInAsAdmin(page);
    await openTab(page, 'customFields');

    await page
      .getByRole('button', {
        name: t('ticketing:customFields.addTo', {
          target: t('ticketing:customFields.targets.ticket').toLocaleLowerCase(),
        }),
        exact: true,
      })
      .click();
    await page
      .getByRole('textbox', { name: t('ticketing:customFields.editor.label'), exact: true })
      .fill(FIELD_LABEL);
    await page
      .getByRole('textbox', { name: t('ticketing:customFields.editor.key'), exact: true })
      .fill(FIELD_KEY);
    await page.getByRole('combobox', { name: t('ticketing:customFields.editor.type') }).click();
    await page
      .getByRole('option', { name: t('ticketing:customFields.types.select'), exact: true })
      .click();
    await page
      .getByRole('button', { name: t('ticketing:customFields.editor.addOption'), exact: true })
      .click();
    await page
      .getByRole('textbox', {
        name: t('ticketing:customFields.editor.optionLabel', { position: 1 }),
      })
      .fill('gold');
    await page
      .getByRole('button', { name: t('ticketing:customFields.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.fieldCreated', { name: FIELD_LABEL }),
    );
  });

  test('creates a template that fills a subject, a tag and a custom value', async ({ page }) => {
    await signInAsAdmin(page);
    await openTab(page, 'templates');

    await page.getByRole('button', { name: t('ticketing:templates.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:templates.editor.name'), exact: true })
      .fill(TEMPLATE);
    await page
      .getByRole('textbox', { name: t('ticketing:templates.editor.subject'), exact: true })
      .fill('Refund for {{contact.first_name}} — {{brand.name}}');
    await page
      .getByRole('textbox', { name: t('ticketing:templates.editor.body'), exact: true })
      .fill('Hello {{contact.first_name}},\n\nWe have started your refund.');
    await page.getByRole('checkbox', { name: TAG }).check();
    // A `select` field's default is a menu, not a text box — the editor draws
    // the control the type needs, because the api validates the default when
    // the template is saved.
    await page.getByRole('combobox', { name: FIELD_LABEL }).click();
    await page.getByRole('option', { name: 'gold', exact: true }).click();
    await page
      .getByRole('button', { name: t('ticketing:templates.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.templateCreated', { name: TEMPLATE }),
    );

    // The preview is rendered by the api. With no contact named, the contact
    // placeholders stay spelled out and are reported rather than blanked.
    await page
      .getByRole('button', { name: t('ticketing:templates.editor.preview'), exact: true })
      .click();
    await expect(
      page.getByText(
        t('ticketing:templates.editor.unknownPlaceholders', { names: 'contact.first_name' }),
      ),
    ).toBeVisible();
  });

  test('creates a ticket from that template, through the api', async ({ page }) => {
    await signInAsAdmin(page);
    const { token, brandId } = await apiSession(page);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const templates = await page.request.get(`/api/brands/${brandId}/ticket-templates`, {
      headers,
    });
    const { templates: list } = (await templates.json()) as {
      templates: { id: string; name: string; usageCount: number }[];
    };
    const template = list.find((row) => row.name === TEMPLATE);
    expect(template).toBeDefined();

    const departments = await page.request.get(`/api/brands/${brandId}/departments`, { headers });
    const { departments: rows } = (await departments.json()) as { departments: { id: string }[] };
    const departmentId = rows[0]?.id ?? '';

    const created = await page.request.post(`/api/brands/${brandId}/tickets`, {
      headers,
      data: { templateId: template?.id, departmentId },
    });

    expect(created.status()).toBe(201);
    const detail = (await created.json()) as {
      ticket: {
        id: string;
        subject: string;
        custom: Record<string, unknown>;
        tags?: { name: string }[];
      };
      messages: { messages: { bodyHtml: string }[] };
    };

    // No contact, so the contact placeholders stay spelled out; the brand's
    // name is filled, because the brand is always known.
    expect(detail.ticket.subject).toContain('{{contact.first_name}}');
    expect(detail.ticket.subject).not.toContain('{{brand.name}}');
    expect(detail.ticket.custom).toEqual({ [FIELD_KEY]: 'gold' });
    expect(detail.ticket.tags?.map((tag) => tag.name)).toEqual([TAG]);
    expect(detail.messages.messages[0]?.bodyHtml).toContain('<p>');

    // The list filter finds it by the tag the template applied, and the
    // template's counter moved in the same transaction as the ticket.
    const tags = await page.request.get(`/api/brands/${brandId}/tags`, { headers });
    const { tags: tagRows } = (await tags.json()) as { tags: { id: string; name: string }[] };
    const tagId = tagRows.find((row) => row.name === TAG)?.id ?? '';

    const filtered = await page.request.get(`/api/brands/${brandId}/tickets?tagId=${tagId}`, {
      headers,
    });
    const { tickets } = (await filtered.json()) as { tickets: { id: string }[] };
    expect(tickets.map((row) => row.id)).toContain(detail.ticket.id);

    const after = await page.request.get(
      `/api/brands/${brandId}/ticket-templates/${template?.id}`,
      { headers },
    );
    expect(((await after.json()) as { usageCount: number }).usageCount).toBe(1);

    // And a value the definition does not accept never reaches the column — in
    // this test for the reason the tag one gives.
    const refused = await page.request.post(`/api/brands/${brandId}/tickets`, {
      headers,
      data: {
        subject: 'Not a choice',
        bodyHtml: '<p>x</p>',
        departmentId,
        custom: { [FIELD_KEY]: 'platinum' },
      },
    });

    expect(refused.status()).toBe(400);
  });
});
