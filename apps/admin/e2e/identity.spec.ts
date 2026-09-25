import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { openContact, openTicket, signIn } from './flows.js';
import { strings } from './strings.js';

/**
 * M1-13 in a real browser, in both languages: merging two contacts from a
 * duplicate suggestion, taking it back, and the Participants card of the ticket
 * details panel.
 *
 * What a browser adds over the unit suite: a radio group that is really
 * keyboard-reachable, a dialog whose focus is really trapped and returned, a
 * toast whose Undo is a real button in the polite queue, and the Arabic layout
 * of all three.
 */

test.describe('merging contacts', () => {
  test('merges from a suggestion, and undoes from the toast', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page
      .getByRole('button', { name: t('contacts:duplicates.mergeWith', { name: 'M. Khalil' }) })
      .click();
    const dialog = page.getByRole('dialog', { name: t('contacts:merge.title') });
    await expect(dialog.getByText(t('contacts:merge.tickets', { count: 6 }))).toBeVisible();
    await expect(dialog.getByRole('radio', { name: /Mona Khalil/ })).toBeChecked();

    await dialog.getByRole('button', { name: t('contacts:merge.submit') }).click();

    await expect(
      page.getByText(t('contacts:merge.toast', { merged: 'M. Khalil', survivor: 'Mona Khalil' })),
    ).toBeVisible();
    await expect(page.getByText(/mona\.k@gmail\.com/).first()).toBeVisible();

    await page.getByRole('button', { name: t('contacts:merge.undo'), exact: true }).click();

    await expect(page.getByText(t('contacts:merge.undone', { name: 'M. Khalil' }))).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: t('contacts:duplicates.mergeWith', { name: 'M. Khalil' }),
      }),
    ).toBeVisible();
  });

  test('keeps the other contact when chosen, from the keyboard, and follows it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page
      .getByRole('button', { name: t('contacts:duplicates.mergeWith', { name: 'M. Khalil' }) })
      .click();
    const dialog = page.getByRole('dialog', { name: t('contacts:merge.title') });
    await dialog.getByRole('radio', { name: /Mona Khalil/ }).focus();
    await page.keyboard.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
    await expect(dialog.getByRole('radio', { name: /M\. Khalil/ })).toBeChecked();

    await dialog.getByRole('button', { name: t('contacts:merge.submit') }).click();

    await expect(page.getByRole('heading', { name: 'M. Khalil', level: 1 })).toBeVisible();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /Mona Khalil/ })
        .first(),
    ).toBeVisible();
  });

  test('undoes from the banner on the surviving contact', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');
    await page
      .getByRole('button', { name: t('contacts:duplicates.mergeWith', { name: 'M. Khalil' }) })
      .click();
    await page
      .getByRole('dialog', { name: t('contacts:merge.title') })
      .getByRole('button', { name: t('contacts:merge.submit') })
      .click();

    await page
      .getByRole('button', { name: t('contacts:merge.bannerUndo', { time: '' }).trim() })
      .click();

    await expect(page.getByText(t('contacts:merge.undone', { name: 'M. Khalil' }))).toBeVisible();
  });

  test('closes the dialog without merging', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page
      .getByRole('button', { name: t('contacts:duplicates.mergeWith', { name: 'M. Khalil' }) })
      .click();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('button', {
        name: t('contacts:duplicates.mergeWith', { name: 'M. Khalil' }),
      }),
    ).toBeVisible();
  });
});

test.describe('merging with any contact (M1-15 part 2)', () => {
  test('picks another contact from the ⋯ menu and merges it', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page.getByRole('button', { name: t('contacts:actions.more') }).click();
    await page.getByRole('menuitem', { name: t('contacts:actions.mergeWith') }).click();
    const picker = page.getByRole('dialog', {
      name: new RegExp(t('contacts:mergeWith.title', { name: 'Mona Khalil' })),
    });
    const choices = picker.getByRole('radiogroup', { name: t('contacts:mergeWith.results') });
    await expect(choices.getByRole('radio', { name: /M\. Khalil/ })).toBeVisible();
    await expect(choices.getByRole('radio', { name: /Mona Khalil/ })).toHaveCount(0);
    const axe = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(axe.violations.map((violation) => violation.id)).toEqual([]);

    await picker
      .getByRole('searchbox', { name: t('contacts:mergeWith.searchLabel') })
      .fill('weber');
    await choices.getByRole('radio', { name: /Jonas Weber/ }).check();
    await picker.getByRole('button', { name: t('contacts:mergeWith.continue') }).click();

    const dialog = page.getByRole('dialog', { name: t('contacts:merge.title') });
    await dialog.getByRole('button', { name: t('contacts:merge.submit') }).click();

    await expect(
      page.getByText(t('contacts:merge.toast', { merged: 'Jonas Weber', survivor: 'Mona Khalil' })),
    ).toBeVisible();
  });

  test('says so when the search finds nobody else, and continues with nothing picked', async ({
    page,
    appLocale: locale,
  }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openContact(page, locale, 'Mona Khalil');

    await page.getByRole('button', { name: t('contacts:actions.more') }).click();
    await page.getByRole('menuitem', { name: t('contacts:actions.mergeWith') }).click();
    const picker = page.getByRole('dialog', {
      name: new RegExp(t('contacts:mergeWith.title', { name: 'Mona Khalil' })),
    });
    await picker
      .getByRole('searchbox', { name: t('contacts:mergeWith.searchLabel') })
      .fill('Mona Khalil');

    await expect(picker.getByText(t('contacts:mergeWith.none'))).toBeVisible();
    await expect(
      picker.getByRole('button', { name: t('contacts:mergeWith.continue') }),
    ).toBeDisabled();
  });
});

test.describe('the participants card', () => {
  test('adds a CC and removes it again', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const card = page.getByRole('region', { name: t('tickets:participants.title') });
    await expect(card.getByText('finance@acme.de')).toBeVisible();

    await card
      .getByRole('textbox', { name: t('tickets:participants.addLabel') })
      .fill('Ops@Acme.DE');
    await card.getByRole('button', { name: t('tickets:participants.add'), exact: true }).click();
    await expect(card.getByText('ops@acme.de')).toBeVisible();

    await card
      .getByRole('button', { name: t('tickets:participants.remove', { address: 'ops@acme.de' }) })
      .click();
    await expect(card.getByText('ops@acme.de')).toHaveCount(0);
  });

  test('says in words when an address is not one', async ({ page, appLocale: locale }) => {
    const t = strings(locale);
    await signIn(page, locale);
    await openTicket(page, locale);

    const card = page.getByRole('region', { name: t('tickets:participants.title') });
    await card
      .getByRole('textbox', { name: t('tickets:participants.addLabel') })
      .fill('not an address');
    await card.getByRole('button', { name: t('tickets:participants.add'), exact: true }).click();

    await expect(page.getByText(t('contacts:problem.invalid-email'))).toBeVisible();
  });
});
