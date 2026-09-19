import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { MOCK_EMAIL, MOCK_USER } from '../src/auth/mock-api.js';
import {
  MOCK_ENROLMENT_CODE,
  MOCK_EXPIRED_INVITE_TOKEN,
  MOCK_INVITE_TOKEN,
} from '../src/staff/mock-api.js';
import { expect, test } from './fixtures.js';
import {
  openContact,
  openContacts,
  openSecurity,
  openStaff,
  signIn,
  submitPassword,
} from './flows.js';
import { strings } from './strings.js';

/**
 * Transitions are off for this file: a menu caught mid-fade reads as low
 * contrast to axe, and DESIGN §4 says reduced motion drops every duration to
 * zero, so this is also the only place that state is exercised.
 */
test.use({ reducedMotion: 'reduce' });

/**
 * DESIGN §10 is checked against WCAG 2.1 A and AA, in both languages. The
 * result is reduced to one line per violation so a failure reads as a list of
 * rules rather than a page of JSON.
 */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  return result.violations.map(
    (violation) =>
      `${violation.id} (${violation.nodes.length}): ${violation.help} — ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  );
}

test.describe('accessibility', () => {
  test('sign in has no violations, with or without an error showing', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/sign-in');
    expect(await violations(page)).toEqual([]);

    await page.getByLabel(t('auth:signIn.emailLabel')).fill(MOCK_EMAIL);
    await page.getByLabel(t('auth:signIn.passwordLabel')).fill('wrong horse');
    await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
    await page.getByRole('alert').waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the code screen has no violations, including its lock banner', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await submitPassword(page, locale);
    expect(await violations(page)).toEqual([]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.getByLabel(t('auth:totp.codeLabel')).fill('000000');
      await page.getByRole('button', { name: t('auth:totp.submit') }).click();
    }
    await expect(page.getByRole('alert')).toHaveText(t('auth:totp.locked'));

    expect(await violations(page)).toEqual([]);
  });

  test('the shell has no violations, with its menus open', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await signIn(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('admin:brandSwitcher.action') }).click();
    await page.getByRole('menu', { name: t('admin:brandSwitcher.action') }).waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the staff screen has no violations, table and invite dialog alike', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await signIn(page, locale);
    await openStaff(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('staff:invite'), exact: true }).click();
    await page.getByRole('dialog').waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the contact list has no violations, filtered or empty', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await signIn(page, locale);
    await openContacts(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByLabel(t('contacts:searchPlaceholder'), { exact: true }).fill('nobody at all');
    await page.getByText(t('contacts:empty.noMatchesHeading')).waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('a contact has no violations, its duplicate warning and dialogs included', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('contacts:detail.edit'), exact: true }).click();
    await page.getByRole('dialog').waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the create form has no violations', async ({ page, appLocale: locale }) => {
    const t = strings(locale);

    await signIn(page, locale);
    await openContacts(page, locale);
    await page.getByRole('button', { name: t('contacts:newContact') }).click();
    await page.getByRole('dialog').waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('two-factor enrolment has no violations on either step', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto('/sign-in/enrol');
    await page.getByRole('img', { name: t('auth:enrolment.step1.qrAlt') }).waitFor();
    expect(await violations(page)).toEqual([]);

    await page.getByLabel(t('auth:enrolment.step1.codeLabel')).fill(MOCK_ENROLMENT_CODE);
    await page.getByRole('button', { name: t('auth:enrolment.step1.submit') }).click();
    await page.getByRole('list', { name: t('auth:enrolment.step2.listLabel') }).waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the invite screen has no violations, live or expired', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await page.goto(`/invite/${MOCK_INVITE_TOKEN}`);
    await page.getByLabel(t('auth:invite.nameLabel')).waitFor();
    expect(await violations(page)).toEqual([]);

    await page.goto(`/invite/${MOCK_EXPIRED_INVITE_TOKEN}`);
    await page.getByRole('heading', { name: t('auth:invite.expiredTitle'), level: 1 }).waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the security page has no violations, including its confirmation', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);

    await signIn(page, locale);
    await openSecurity(page, locale);
    expect(await violations(page)).toEqual([]);

    await page.getByRole('button', { name: t('me:twoFactor.disable'), exact: true }).click();
    await page.getByRole('dialog').waitFor();

    expect(await violations(page)).toEqual([]);
  });

  test('the account menu, which carries the presence toggle, has no violations', async ({
    page,
    appLocale: locale,
  }) => {
    const menuLabel = strings(locale)('admin:currentUser.menuLabel', { name: MOCK_USER.name });

    await signIn(page, locale);
    await page.getByRole('button', { name: menuLabel }).click();
    await page.getByRole('menu', { name: menuLabel }).waitFor();

    expect(await violations(page)).toEqual([]);
  });
});
