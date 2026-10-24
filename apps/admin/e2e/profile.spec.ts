import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { openSecurity, settingsTab, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M14-12 in a real browser, in both languages (`Admin/Account-Profile`): Your
 * account › Profile, where a person sets how customers see them, uploads a
 * photo, and finds the single-key shortcuts switch. The api is the mock
 * adapter, which keeps the api's rules (an international phone, a 5 MB cap,
 * JPEG, PNG or WebP by the bytes); the real sniff and re-encode are the api's
 * integration suite.
 */

test.use({ reducedMotion: 'reduce' });

/** A 1 × 1 PNG: real bytes, so the mock's sniff accepts it. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
}

async function openProfile(page: Page, locale: 'en' | 'ar'): Promise<void> {
  const t = strings(locale);
  await signIn(page, locale);
  await openSecurity(page, locale);
  await settingsTab(page, t, 'me:account.tabs.profile').click();
  await page.getByRole('heading', { name: t('me:profile.heading'), level: 2 }).waitFor();
  // The fields fill from the stored profile a frame after the heading.
  await expect(page.getByLabel(t('me:profile.jobTitleEn'))).toHaveValue('Billing specialist');
}

test('shows the stored profile and passes axe', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await openProfile(page, locale);

  await expect(page.getByLabel(t('me:profile.name'), { exact: true })).toHaveValue('Lina Haddad');
  await expect(page.getByLabel(t('me:profile.phone'))).toHaveValue('+966551234567');
  await expect(page.getByLabel(t('me:profile.timeZone'))).toHaveValue('Asia/Riyadh');
  await expect(page.getByLabel(t('me:profile.jobTitleAr'))).toHaveAttribute('dir', 'rtl');
  await expect(page.getByLabel(t('me:profile.jobTitleEn'))).toHaveAttribute('dir', 'ltr');
  expect(await violations(page)).toEqual([]);
});

test('saves the public name, a title and the phone in international form, and keeps them', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openProfile(page, locale);

  await page.getByLabel(t('me:profile.publicName'), { exact: true }).fill('Lina H');
  await page.getByLabel(t('me:profile.jobTitleEn')).fill('Support lead');
  await page.getByLabel(t('me:profile.phone')).fill('00966 55 987 6543');
  await page.getByRole('button', { name: t('me:profile.save') }).click();

  await expect(page.getByText(t('me:profile.saved'))).toBeVisible();

  // Away and back: what was saved is what comes back, with the phone normalised.
  await settingsTab(page, t, 'me:account.tabs.security').click();
  await settingsTab(page, t, 'me:account.tabs.profile').click();
  await expect(page.getByLabel(t('me:profile.publicName'), { exact: true })).toHaveValue('Lina H');
  await expect(page.getByLabel(t('me:profile.jobTitleEn'))).toHaveValue('Support lead');
  await expect(page.getByLabel(t('me:profile.phone'))).toHaveValue('+966559876543');
});

test('says what is wrong with a phone number that is not international, and saves nothing', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openProfile(page, locale);

  await page.getByLabel(t('me:profile.publicName'), { exact: true }).fill('Not saved');
  await page.getByLabel(t('me:profile.phone')).fill('0551234567');
  await page.getByRole('button', { name: t('me:profile.save') }).click();

  const phone = page.getByLabel(t('me:profile.phone'));
  await expect(page.getByText(t('me:profile.phoneInvalid'))).toBeVisible();
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: t('me:profile.discard') }).click();
  await expect(page.getByLabel(t('me:profile.publicName'), { exact: true })).toHaveValue('');
  await expect(phone).toHaveValue('+966551234567');
});

test('uploads a photo, shows it, and removes it again', async ({ page, appLocale: locale }) => {
  const t = strings(locale);
  await openProfile(page, locale);
  const remove = page.getByRole('button', { name: t('me:profile.photoRemove') });
  await expect(remove).toBeDisabled();

  await page.getByTestId('profile-photo-input').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: PIXEL,
  });

  await expect(page.getByText(t('me:profile.photoUpdated'))).toBeVisible();
  await expect(page.getByRole('img', { name: t('me:profile.photoAlt') })).toBeVisible();
  await expect(remove).toBeEnabled();
  expect(await violations(page)).toEqual([]);

  await remove.click();
  await expect(page.getByText(t('me:profile.photoRemoved'))).toBeVisible();
  await expect(page.getByRole('img', { name: t('me:profile.photoAlt') })).toHaveCount(0);
});

test('refuses a file that is not an image by its bytes, and one over 5 MB', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openProfile(page, locale);
  const input = page.getByTestId('profile-photo-input');

  await input.setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: Buffer.from('<script>alert(1)</script>'),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: t('me:profile.photoUnsupported') }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await input.setInputFiles({
    name: 'big.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([PIXEL, Buffer.alloc(5 * 1024 * 1024)]),
  });
  await expect(
    page.getByRole('alert').filter({ hasText: t('me:profile.photoTooLarge') }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: t('me:profile.photoAlt') })).toHaveCount(0);
});

test('holds the single-key shortcuts switch, which stays where it was put', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openProfile(page, locale);
  const section = page.getByRole('region', { name: t('me:profile.workingHeading') });
  const toggle = section.getByRole('switch', { name: t('me:profile.singleKeys') });

  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  await settingsTab(page, t, 'me:account.tabs.security').click();
  await settingsTab(page, t, 'me:account.tabs.profile').click();
  await expect(
    page
      .getByRole('region', { name: t('me:profile.workingHeading') })
      .getByRole('switch', { name: t('me:profile.singleKeys') }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('the signature preview fills its placeholders from the profile', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await openProfile(page, locale);
  await settingsTab(page, t, 'me:account.tabs.signature').click();
  await page.getByRole('heading', { name: t('me:signature.heading'), level: 2 }).waitFor();

  await page
    .getByLabel(t('me:signature.en'), { exact: true })
    .fill('{{agent.name}}\n{{agent.title}} · {{brand.name}}');
  await page.getByLabel(new RegExp(t('me:signature.ar'))).fill('{{agent.name}}\n{{agent.title}}');

  const preview = page.getByRole('complementary', { name: t('me:signature.previewHeading') });
  await expect(preview.getByText('Billing specialist · Helpdock')).toBeVisible();
  await expect(preview.getByText('أخصائية الفوترة')).toBeVisible();
  await expect(preview.getByText('{{', { exact: false })).toHaveCount(0);
});
