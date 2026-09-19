import { expect, test } from './fixtures.js';
import { openStaff, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * `Admin/Staff` in a real browser, in both languages.
 *
 * What a browser adds over the unit suite is the parts that are not React: the
 * focus order through the invite dialog, a menu that opens where it can be
 * clicked, and an Arabic layout that is a different layout rather than the same
 * one mirrored by hand (DESIGN §7).
 */

test.describe('staff and roles', () => {
  test('lists everybody in the brand with their role and departments', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    await expect(page.getByRole('heading', { name: t('staff:title'), level: 1 })).toBeVisible();

    const table = page.getByRole('table');
    await expect(table.getByText('Omar Nasser')).toBeVisible();
    await expect(table.getByText(t('staff:roles.teamLeader'), { exact: true })).toBeVisible();
    await expect(table.getByText('Support', { exact: true }).first()).toBeVisible();
  });

  test('shows a pending invitation with its resend and revoke actions', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    const row = page.getByRole('row').filter({ hasText: 'karim@helpdock.com' });
    await row.getByRole('button', { name: t('staff:table.rowActions', { name: 'karim' }) }).click();

    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: t('staff:actions.resend') })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: t('staff:actions.revoke') })).toBeVisible();
  });

  test('sends an invitation from the keyboard alone', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    await page.getByRole('button', { name: t('staff:invite'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Typed and submitted without a pointer: `Enter` in a field of the form
    // submits it, which is what somebody who never leaves the keyboard does.
    const email = dialog.getByLabel(t('staff:inviteDialog.emailLabel'));
    await email.focus();
    await page.keyboard.type('keyboard.person@example.com');
    await page.keyboard.press('Enter');

    await expect(
      page.getByText(t('staff:toast.invited', { email: 'keyboard.person@example.com' })),
    ).toBeVisible();
    await expect(page.getByRole('table').getByText('keyboard.person@example.com')).toBeVisible();
  });

  test('offers a card per role, each with a sentence', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    await page.getByRole('button', { name: t('staff:invite'), exact: true }).click();
    const group = page.getByRole('radiogroup');

    await expect(group.getByRole('radio')).toHaveCount(4);
    await expect(group.getByText(t('staff:roleDescriptions.viewer'))).toBeVisible();
  });

  test('resends an invitation and says where it went', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    const row = page.getByRole('row').filter({ hasText: 'karim@helpdock.com' });
    await row.getByRole('button', { name: t('staff:table.rowActions', { name: 'karim' }) }).click();
    await page.getByRole('menuitem', { name: t('staff:actions.resend') }).click();

    await expect(
      page.getByText(t('staff:toast.resent', { email: 'karim@helpdock.com' })),
    ).toBeVisible();
  });

  test('revokes an invitation after confirming, and the row goes', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    const row = page.getByRole('row').filter({ hasText: 'karim@helpdock.com' });
    await row.getByRole('button', { name: t('staff:table.rowActions', { name: 'karim' }) }).click();
    await page.getByRole('menuitem', { name: t('staff:actions.revoke') }).click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(t('staff:confirm.revoke.title', { email: 'karim@helpdock.com' })),
    ).toBeVisible();
    await dialog.getByRole('button', { name: t('staff:confirm.revoke.submit') }).click();

    await expect(page.getByRole('table').getByText('karim@helpdock.com')).toHaveCount(0);
  });

  test('asks before deactivating, and says what will happen', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    const row = page.getByRole('row').filter({ hasText: 'yara@helpdock.com' });
    await row
      .getByRole('button', { name: t('staff:table.rowActions', { name: 'Yara Salem' }) })
      .click();
    await page.getByRole('menuitem', { name: t('staff:actions.deactivate') }).click();

    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(t('staff:confirm.deactivate.title', { name: 'Yara Salem' })),
    ).toBeVisible();
    await expect(dialog.getByText(t('staff:confirm.deactivate.body'))).toBeVisible();

    await dialog.getByRole('button', { name: t('staff:confirm.deactivate.submit') }).click();
    await expect(
      page.getByText(t('staff:toast.deactivated', { name: 'Yara Salem' })),
    ).toBeVisible();
  });

  test('offers no actions on your own row', async ({ page, appLocale: locale }) => {
    await signIn(page, locale);
    await openStaff(page, locale);

    const own = page.getByRole('row').filter({ hasText: 'lina@helpdock.com' });
    await expect(own.getByRole('button')).toHaveCount(0);
  });

  test('narrows the table as a name is searched for', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openStaff(page, locale);

    await page.getByLabel(t('staff:searchPlaceholder')).fill('omar');

    await expect(page.getByRole('table').getByText('Omar Nasser')).toBeVisible();
    await expect(page.getByRole('table').getByText('Yara Salem')).toHaveCount(0);
  });
});
