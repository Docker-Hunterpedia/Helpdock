import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';
import { signIn } from './flows.js';
import { strings } from './strings.js';

test('M14-28 groups events, requires a selection, and persists the notes opt-in', async ({
  page,
  appLocale: locale,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const t = strings(locale);
  await signIn(page, locale);
  await page.getByRole('link', { name: t('admin:nav.developers'), exact: true }).click();
  await page.getByRole('tab', { name: t('developers:tabs.webhooks') }).click();
  await page
    .getByRole('button', { name: t('developers:webhooks.add'), exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: t('developers:webhooks.form.addTitle') });
  await dialog.getByLabel(t('developers:webhooks.form.url')).fill('https://example.com/new-events');
  await dialog.getByRole('button', { name: t('developers:webhooks.add'), exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(t('developers:webhooks.form.eventsRequired'));
  for (const group of ['tickets', 'messages', 'contacts'] as const) {
    await expect(
      dialog.getByRole('group', { name: t(`developers:webhooks.groups.${group}`), exact: true }),
    ).toBeVisible();
  }
  const selected = [
    'ticket.assigned',
    'ticket.status_changed',
    'ticket.merged',
    'message.created',
    'contact.updated',
    'contact.merged',
    'account.created',
    'account.updated',
  ];
  for (const event of selected)
    await dialog.getByRole('checkbox', { name: event, exact: true }).check();
  const notes = dialog.getByRole('checkbox', {
    name: t('developers:webhooks.includeInternalNotes'),
    exact: true,
  });
  await expect(notes).toHaveAccessibleDescription(t('developers:webhooks.notesHint'));
  await expect(notes).not.toBeChecked();
  await notes.check();
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  await dialog.getByRole('button', { name: t('developers:webhooks.add'), exact: true }).click();
  const reveal = page.getByRole('dialog', { name: t('developers:webhooks.created.title') });
  await expect(reveal).toBeVisible();
  await reveal.getByRole('button', { name: t('developers:done') }).click();
  const row = page.getByRole('row').filter({ hasText: 'https://example.com/new-events' });
  await row
    .getByRole('button', {
      name: t('developers:webhooks.actionsFor', { url: 'https://example.com/new-events' }),
    })
    .click();
  await page.getByRole('menuitem', { name: t('developers:webhooks.menu.edit') }).click();
  const edit = page.getByRole('dialog', { name: t('developers:webhooks.form.editTitle') });
  await expect(
    edit.getByRole('checkbox', {
      name: t('developers:webhooks.includeInternalNotes'),
      exact: true,
    }),
  ).toBeChecked();
  for (const event of selected)
    await expect(
      edit.getByRole('checkbox', {
        name: event,
        exact: true,
      }),
    ).toBeChecked();
  await edit
    .getByRole('checkbox', { name: t('developers:webhooks.includeInternalNotes'), exact: true })
    .uncheck();
  await edit.getByRole('button', { name: t('developers:webhooks.form.save'), exact: true }).click();
  await row
    .getByRole('button', {
      name: t('developers:webhooks.actionsFor', { url: 'https://example.com/new-events' }),
    })
    .click();
  await page.getByRole('menuitem', { name: t('developers:webhooks.menu.edit') }).click();
  await expect(
    edit.getByRole('checkbox', {
      name: t('developers:webhooks.includeInternalNotes'),
      exact: true,
    }),
  ).not.toBeChecked();
  expect(errors).toEqual([]);
});
