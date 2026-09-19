import { expect, test } from '@playwright/test';
import { generate } from 'otplib';
import { strings } from '../strings.js';
import { ACCOUNT_EMAIL_ENV, ACCOUNT_PASSWORD_ENV, SKIP_ENV, TOTP_SECRET_ENV } from './install.js';

/**
 * M1-01 against the real api: a department created, a team added to it, the
 * install admin put on that team, and the department deleted again.
 *
 * The mock suite covers the screens in both languages. What this adds is
 * everything under them — the `departments`, `teams` and `team_members` rows
 * written through row-level security inside one request transaction, the
 * eligible-member query that reads `user_brand_roles`, the audit rows, and the
 * refusal a brand's last department answers with.
 *
 * One worker and one install, so these run in order: the department created in
 * the first test is the one the last one deletes.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

test.describe.configure({ mode: 'serial' });

const t = strings('en');

/**
 * Unique per run. The three tests share one install and run in order, so a run
 * that fails halfway would otherwise leave the department behind and the next
 * run would be refused for the name.
 */
const RUN = String(Date.now()).slice(-6);
const DEPARTMENT = `Billing ${RUN}`;
const TEAM = `Front line ${RUN}`;

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

const openTicketing = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.getByRole('link', { name: new RegExp(t('admin:nav.ticketing')) }).click();
  await page.getByRole('table').waitFor();
};

test.describe('ticketing settings against the real api', () => {
  test('creates a department, which then appears in the list', async ({ page }) => {
    await signInAsAdmin(page);
    await openTicketing(page);

    await page.getByRole('button', { name: t('ticketing:departments.add'), exact: true }).click();
    await page
      .getByRole('textbox', { name: t('ticketing:departments.editor.name'), exact: true })
      .fill(DEPARTMENT);
    await page
      .getByRole('button', { name: t('ticketing:departments.editor.create'), exact: true })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.departmentCreated', { name: DEPARTMENT }),
    );
    await expect(
      page.getByRole('button', {
        name: t('ticketing:departments.table.select', { name: DEPARTMENT }),
      }),
    ).toBeVisible();
  });

  test('adds a team to it and puts the administrator on it', async ({ page }) => {
    await signInAsAdmin(page);
    await openTicketing(page);

    await page
      .getByRole('button', { name: t('ticketing:departments.table.select', { name: DEPARTMENT }) })
      .click();
    await page
      .getByRole('textbox', { name: t('ticketing:departments.teams.namePlaceholder') })
      .fill(TEAM);
    await page
      .getByRole('button', { name: t('ticketing:departments.teams.add'), exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.teamCreated', { name: TEAM }),
    );

    // The picker is the api's own eligible-member answer, so whoever is in it
    // holds a role in this brand that reaches this department.
    await page.getByLabel(t('ticketing:departments.teams.picker', { team: TEAM })).click();
    const person = page.getByRole('option').first();
    const name = (await person.textContent()) ?? '';
    await person.click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.memberAdded', { name, team: TEAM }),
    );

    // The department row counts what the teams hold, which only a second read
    // from the server can show.
    await page.reload();
    await page.getByRole('table').waitFor();
    const row = page.getByRole('row').filter({ hasText: DEPARTMENT });
    await expect(row).toContainText('1');
  });

  test('deletes the department it made, and keeps the brand’s last one', async ({ page }) => {
    await signInAsAdmin(page);
    await openTicketing(page);

    await page
      .getByRole('button', {
        name: t('ticketing:departments.table.rowActions', { name: DEPARTMENT }),
      })
      .click();
    await page
      .getByRole('menuitem', { name: t('ticketing:departments.actions.delete'), exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: t('ticketing:departments.confirm.delete.submit') })
      .click();

    await expect(page.getByRole('status')).toContainText(
      t('ticketing:toast.departmentDeleted', { name: DEPARTMENT }),
    );

    // What is left is the department the seed created, and the api refuses to
    // take it away: a brand with none has nowhere to file a ticket.
    const remaining = page.getByRole('row').nth(1);
    const lastName = ((await remaining.getByRole('cell').nth(1).textContent()) ?? '').trim();

    await remaining
      .getByRole('button', {
        name: t('ticketing:departments.table.rowActions', { name: lastName }),
      })
      .click();
    await page
      .getByRole('menuitem', { name: t('ticketing:departments.actions.delete'), exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: t('ticketing:departments.confirm.delete.submit') })
      .click();

    await expect(page.getByRole('status')).toContainText(t('ticketing:toast.lastDepartment'));
  });
});
