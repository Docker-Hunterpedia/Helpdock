import AxeBuilder from '@axe-core/playwright';
import { importBrowserReadySchema, importBrowserSnapshotSchema } from '@helpdock/importers/testing';
import {
  authSessionResponseSchema,
  type ImportMapping,
  importDryRunReportSchema,
  importMappingKindSchema,
  importMappingSchema,
  importMappingsViewSchema,
  importMappingValuesSchema,
  importRunViewSchema,
  ticketListSchema,
} from '@helpdock/schemas';
import { z } from 'zod';
import { expect, test } from '../fixtures.js';
import { strings } from '../strings.js';
import { IMPORT_CONTROL_KEY_ENV, IMPORT_READY_ENV, IMPORT_SKIP_ENV } from './import-install.js';
import { freshTotpCode } from './totp.js';

test.skip(
  Boolean(process.env[IMPORT_SKIP_ENV]),
  'Docker is unavailable; no real import install was started.',
);

test('imports source history through the real wizard without sending anything', async ({
  page,
  appLocale: locale,
}) => {
  const ready = importBrowserReadySchema.parse(JSON.parse(process.env[IMPORT_READY_ENV] ?? '{}'));
  const t = strings(locale);
  await page.goto('/sign-in');
  await page.getByLabel(t('auth:signIn.emailLabel')).fill(ready.email);
  await page.getByLabel(t('auth:signIn.passwordLabel')).fill(ready.password);
  await page.getByRole('button', { name: t('auth:signIn.submit'), exact: true }).click();
  await page.getByLabel(t('auth:totp.codeLabel')).fill(await freshTotpCode(ready.totpSecret));
  const authenticated = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/totp') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: t('auth:totp.submit') }).click();
  const session = authSessionResponseSchema.parse(await (await authenticated).json());
  await expect(page.getByRole('navigation', { name: t('admin:nav.label') })).toBeVisible();
  const api = async <T>(
    schema: z.ZodType<T>,
    method: 'GET' | 'PUT',
    endpoint: string,
    data?: unknown,
  ) => {
    const response = await page.request.fetch(`/api/brands/${ready.brandId}/${endpoint}`, {
      method,
      headers: { authorization: `Bearer ${session.accessToken}` },
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), `${method} ${endpoint}`).toBe(true);
    return schema.parse(await response.json());
  };

  await page.getByRole('link', { name: t('admin:nav.brand'), exact: true }).click();
  await page.getByRole('tab', { name: t('brand:tabs.import') }).click();
  await page.getByRole('button').filter({ hasText: 'Zendesk' }).click();
  await page.waitForURL(/\/admin\/brand\/import\/[0-9a-f-]+$/);
  const runId = z.uuid().parse(new URL(page.url()).pathname.split('/').at(-1));
  await page.getByLabel(t('imports:connection.subdomain')).fill('demo');
  await page.getByRole('radio', { name: t('imports:connection.oauthToken'), exact: true }).check();
  const tokenField = page
    .getByLabel(t('imports:connection.oauthToken'), { exact: true })
    .and(page.locator('input[type="password"]'));
  await tokenField.fill('refused-synthetic-token');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await expect(page.getByText(t('imports:connection.failed'))).toBeVisible();
  await tokenField.fill('synthetic-browser-token');
  await page.getByLabel(t('imports:connection.downloadHosts')).fill('cdn.zendesk.test');
  await page.getByRole('button', { name: t('imports:connection.test') }).click();
  await page.getByRole('button', { name: t('imports:scope.extract') }).click();
  await expect
    .poll(async () => (await api(importRunViewSchema, 'GET', `imports/${runId}`)).status, {
      timeout: 60000,
    })
    .toBe('awaiting_mapping');

  // Confirm choices through the public API, then review the staged source
  // records and approve their import in the browser.
  const mappings: ImportMapping[] = [];
  for (const kind of importMappingKindSchema.options) {
    const values = await api(
      importMappingValuesSchema,
      'GET',
      `imports/${runId}/mapping-values?kind=${kind}&limit=100`,
    );
    expect(values.nextCursor).toBeNull();
    for (const row of values.values) {
      const target =
        kind === 'group'
          ? { departmentId: ready.departmentId, teamId: null }
          : kind === 'agent'
            ? { kind: 'existing', userId: ready.userId }
            : kind === 'tag'
              ? { tagId: ready.tagId }
              : row.proposed?.target;
      if (!target) throw new Error(`Unmapped browser fixture: ${kind}:${row.externalValue}`);
      mappings.push(importMappingSchema.parse({ kind, externalValue: row.externalValue, target }));
    }
  }
  await api(importMappingsViewSchema, 'PUT', `imports/${runId}/mappings`, { mappings });
  await page.reload();
  const priorityTab = page.getByRole('tab', {
    name: t('imports:mapping.kinds.priority'),
    exact: true,
  });
  await priorityTab.click();
  const priority = page
    .getByRole('combobox', { name: t('imports:mapping.destination'), exact: true })
    .first();
  const confirmedPriority = mappings.find((mapping) => mapping.kind === 'priority');
  if (confirmedPriority?.kind !== 'priority') throw new Error('Missing confirmed priority');
  // A closed row names its saved destination without opening the catalog search.
  await expect(priority).toHaveValue(confirmedPriority.target.priority);
  await priority.click();
  await page.getByRole('option', { name: 'high', exact: true }).click();
  await page.getByRole('button', { name: t('imports:mapping.save'), exact: true }).click();
  await expect(
    page.getByRole('tab', { name: t('imports:mapping.kinds.status'), exact: true }),
  ).toBeEnabled();
  expect(
    (await api(importMappingsViewSchema, 'GET', `imports/${runId}/mappings`)).mappings.some(
      (mapping) => mapping.kind === 'priority' && mapping.target.priority === 'high',
    ),
  ).toBe(true);
  await page.reload();
  await priorityTab.click();
  await expect(priority).toHaveValue('high');
  await page.getByRole('button', { name: t('imports:dryRun.rerun') }).click();
  await expect
    .poll(
      async () => (await api(importDryRunReportSchema, 'GET', `imports/${runId}/dry-run`)).complete,
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(page.getByText(t('imports:dryRun.fileStates.available')).first()).toBeVisible();
  await expect(page.getByText('receipt.pdf').first()).toBeVisible();
  await expect(page.getByText('Original customer').first()).toBeVisible();
  await expect(page.getByText('Private note', { exact: true }).first()).toBeVisible();
  const report = await api(importDryRunReportSchema, 'GET', `imports/${runId}/dry-run`);
  expect(report.errors).toBe(0);
  const start = page.getByRole('button', { name: t('imports:dryRun.start') });
  if (report.warnings > 0) {
    await expect(start).toBeDisabled();
    await page.getByRole('checkbox', { name: t('imports:dryRun.acknowledge') }).check();
  }
  await expect(start).toBeEnabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await start.click();
  await expect(page.getByText(t('imports:status.completed'), { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const run = await api(importRunViewSchema, 'GET', `imports/${runId}`);
  expect(run.hasCredentials).toBe(false);
  expect(JSON.stringify(run)).not.toContain('synthetic-browser-token');
  const history = await api(ticketListSchema, 'GET', 'tickets?q=101');
  expect(history.tickets).toHaveLength(1);
  const ticket = history.tickets[0];
  if (!ticket) throw new Error('Imported ticket is missing');
  expect(ticket.createdAt).toBe('2020-01-01T10:00:00.000Z');
  await page.goto(`/tickets/${ticket.id}`);
  await expect(page.getByText('Private note', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('receipt.pdf').first()).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  const checked = await page.request.get(`${ready.controlOrigin}/snapshot`, {
    headers: { authorization: `Bearer ${process.env[IMPORT_CONTROL_KEY_ENV] ?? ''}` },
  });
  expect(checked.ok()).toBe(true);
  expect(importBrowserSnapshotSchema.parse(await checked.json())).toEqual({
    tickets: 1,
    messages: 2,
    files: 1,
    retained_credentials: 0,
    managedBytesMatch: true,
    sourceReadOnly: true,
    unexpectedOutbox: 0,
    sends: { smtp: 0, webhook: 0, telegram: 0, graph: 0 },
    inert: {
      workflow_runs: 0,
      ticket_sla_clocks: 0,
      notifications: 0,
      ai_calls: 0,
      webhook_deliveries: 0,
    },
  });
});
