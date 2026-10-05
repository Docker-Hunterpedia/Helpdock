import AxeBuilder from '@axe-core/playwright';
import type { Locale } from '@helpdock/i18n';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/AI` (M7-10; `Admin/AI-Providers`, `Admin/AI-Assistant`) in a real
 * browser, in both languages, against the fixture: replacing a key and
 * discovering models, the refusal a revoked key gets, the embedding model's
 * 2000-dimension limit and re-embed confirmation, the hard-stop banner and
 * the modes, and no accessibility violations on either tab.
 */

test.use({ reducedMotion: 'reduce' });

/** Through the sidebar: the fixture keeps its session in memory, so a reload signs out. */
const openAi = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.ai'), exact: true }).click();
  await page.getByRole('table', { name: t('aiSettings:providers.tableLabel') }).waitFor();
};

const openAssistant = async (page: Page, locale: Locale): Promise<void> => {
  const t = strings(locale);
  await openAi(page, locale);
  await page.getByRole('tab', { name: t('aiSettings:tabs.assistant') }).click();
  await page.getByRole('region', { name: t('aiSettings:modes.heading') }).waitFor();
};

const violations = async (page: Page): Promise<string[]> => {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
};

test.describe('AI providers', () => {
  test('replaces a key, saves the provider and discovers its models', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAi(page, locale);
    const form = page.getByRole('region', { name: 'OpenAI' });

    await form
      .getByRole('button', { name: t('aiSettings:provider.replaceKey', { name: 'OpenAI' }) })
      .click();
    await form.getByRole('textbox', { name: t('aiSettings:provider.apiKey') }).fill('sk-rotated');
    await form.getByRole('button', { name: t('aiSettings:provider.save') }).click();
    await expect(page.getByText(t('aiSettings:provider.saved'))).toBeVisible();

    await form.getByRole('button', { name: t('aiSettings:provider.discover') }).click();
    await expect(form.getByText(t('aiSettings:provider.modelsFound', { count: 4 }))).toBeVisible();
    await expect(form.getByText('gpt-4.1-mini')).toBeVisible();
  });

  test('says why a provider refused, and refuses more than 2000 dimensions', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAi(page, locale);

    await page
      .getByRole('button', { name: t('aiSettings:providers.edit', { name: 'OpenRouter' }) })
      .click();
    const form = page.getByRole('region', { name: 'OpenRouter' });
    await form.getByRole('button', { name: t('aiSettings:provider.discover') }).click();
    await expect(form.getByRole('alert')).toHaveText(t('aiSettings:refusals.discovery-failed'));

    const embeddings = page.getByRole('region', { name: t('aiSettings:embeddings.heading') });
    await embeddings.getByLabel(t('aiSettings:embeddings.dims')).fill('3072');
    await embeddings.getByRole('button', { name: t('aiSettings:save'), exact: true }).click();
    await expect(
      embeddings.getByText(t('aiSettings:embeddings.problems.dimsTooMany', { dims: '3072' })),
    ).toBeVisible();
  });

  test('asks before a model change re-embeds, then shows the reindex', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await openAi(page, locale);
    const embeddings = page.getByRole('region', { name: t('aiSettings:embeddings.heading') });

    await embeddings.getByLabel(t('aiSettings:embeddings.model')).fill('text-embedding-3-large');
    await embeddings.getByRole('button', { name: t('aiSettings:save'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: t('aiSettings:embeddings.dialog.title') });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: t('aiSettings:embeddings.dialog.confirm') }).click();

    await expect(
      embeddings.getByRole('progressbar', { name: t('aiSettings:embeddings.progressLabel') }),
    ).toBeVisible();
    await expect(embeddings.getByLabel(t('aiSettings:embeddings.model'))).toBeDisabled();
  });

  test('has no accessibility violations', async ({ page, appLocale: locale }) => {
    await openAi(page, locale);
    expect(await violations(page)).toEqual([]);
  });
});

test.describe('AI assistant', () => {
  test('shows the hard stop and saves a mode change', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openAssistant(page, locale);

    await expect(page.getByRole('alert').first()).toContainText(t('aiSettings:budgetBanner.raise'));
    const modes = page.getByRole('region', { name: t('aiSettings:modes.heading') });
    const email = t('aiSettings:channels.email');
    await modes
      .getByRole('switch', { name: t('aiSettings:modes.autoReplyOn', { channel: email }) })
      .click();
    await expect(
      modes.getByRole('slider', { name: t('aiSettings:modes.threshold', { channel: email }) }),
    ).toBeVisible();
    await modes.getByRole('button', { name: t('aiSettings:modes.save') }).click();
    await expect(page.getByText(t('aiSettings:modes.saved'))).toBeVisible();
  });

  test('refuses a limit of zero', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await openAssistant(page, locale);
    const budget = page.getByRole('region', { name: t('aiSettings:budget.heading') });

    await budget.getByLabel(t('aiSettings:budget.limit.day')).fill('0');
    await budget.getByRole('button', { name: t('aiSettings:budget.save') }).click();
    await expect(budget.getByText(t('aiSettings:budget.invalid'))).toBeVisible();
  });

  test('has no accessibility violations', async ({ page, appLocale: locale }) => {
    await openAssistant(page, locale);
    await page
      .getByRole('list', { name: strings(locale)('aiSettings:activity.listLabel') })
      .waitFor();
    expect(await violations(page)).toEqual([]);
  });
});
