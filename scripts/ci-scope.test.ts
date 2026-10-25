import { describe, expect, it } from 'vitest';
import { classifyChanges, readWorkspaces } from './ci-scope.ts';

const workspaces = readWorkspaces(process.cwd());
const scope = (path: string) => classifyChanges([{ filename: path }], 1, workspaces);

describe('CI workspace selection', () => {
  it('runs admin coverage and browsers without unrelated API or package suites', () => {
    expect(scope('apps/admin/src/main.tsx')).toMatchObject({
      run_admin: true,
      run_api: false,
      run_unit: false,
      run_integration: false,
      run_widget: false,
      run_browser_api: true,
      run_image: true,
    });
  });
  it('runs API coverage and real API browsers without admin fixture suites', () => {
    expect(scope('apps/api/src/auth/auth.service.ts')).toMatchObject({
      run_api: true,
      run_admin: false,
      run_integration: false,
      run_browser_api: true,
    });
  });
  it('propagates schemas through config, database, jobs and every app consumer', () => {
    expect(scope('packages/schemas/src/tickets.ts')).toMatchObject({
      run_api: true,
      run_admin: true,
      run_widget: true,
      run_unit: true,
      run_integration: true,
    });
  });
  it('keeps server-only shared changes away from admin suites', () => {
    expect(scope('packages/ai/src/index.ts')).toMatchObject({
      run_api: true,
      run_admin: false,
      run_unit: true,
      run_integration: true,
    });
  });
  it('does not start heavy jobs for documentation', () => {
    expect(scope('docs/design/artboards/AdminImport.dc.html')).toMatchObject({
      run_full: false,
      run_api: false,
      run_admin: false,
      run_unit: false,
      run_image: false,
    });
  });
  it.each([
    'site/src/pages/index.astro',
    'site/src/styles/site.css',
    'site/public/assets/img/ticket-view-en.webp',
  ])('starts no suite for the static website file %s', (path) => {
    expect(scope(path)).toMatchObject({
      run_full: false,
      run_api: false,
      run_admin: false,
      run_widget: false,
      run_unit: false,
      run_integration: false,
      run_browser_api: false,
      run_image: false,
      run_semgrep: false,
    });
  });
  it('still runs the suites of an app changed beside the website', () => {
    expect(
      classifyChanges(
        [{ filename: 'site/src/pages/index.astro' }, { filename: 'apps/admin/src/main.tsx' }],
        2,
        workspaces,
      ),
    ).toMatchObject({ run_full: false, run_admin: true, run_api: false });
  });
  it.each([
    ['docs/guides/configuration.md', '@helpdock/config'],
    ['docs/guides/webhooks.md', '@helpdock/jobs'],
  ])('runs the package suite that renders the generated guide %s', (path) => {
    expect(scope(path)).toMatchObject({ run_full: false, run_unit: true });
  });
  it('includes the source of a rename out of a workspace', () => {
    expect(
      classifyChanges(
        [{ filename: 'docs/removed.md', previous_filename: 'apps/api/src/old.ts' }],
        1,
        workspaces,
      ).run_api,
    ).toBe(true);
  });
  it.each([
    'pnpm-lock.yaml',
    'apps/admin/package.json',
    '.github/workflows/ci.yml',
    'apps/new-app/src/index.ts',
    'scripts/check-app-boundaries.ts',
  ])('runs the full suite for global or unknown path %s', (path) => {
    expect(scope(path).run_full).toBe(true);
  });
  it('skips every suite for a release PR that only bumps a manifest version', () => {
    const release = classifyChanges(
      [
        { filename: 'apps/api/CHANGELOG.md' },
        {
          filename: 'apps/api/package.json',
          patch:
            '@@ -1,6 +1,6 @@\n   "name": "@helpdock/api",\n-  "version": "0.5.1",\n+  "version": "0.6.0",',
        },
      ],
      2,
      workspaces,
    );
    expect(release).toMatchObject({ run_full: false, run_api: false, run_image: false });
  });
  it('treats any other manifest edit as a global change', () => {
    const dependency = {
      filename: 'apps/api/package.json',
      patch: '@@ -1 +1 @@\n-    "zod": "4.1.0",\n+    "zod": "4.2.0",',
    };
    expect(classifyChanges([dependency], 1, workspaces).run_full).toBe(true);
  });
  it.each([
    'apps/api/src/imports/jobs/extract-run.ts',
    'apps/api/src/help-center/imported-articles.ts',
    'packages/importers/src/zendesk/client.ts',
    'packages/db/drizzle/0054_imports.sql',
  ])('runs the reference imports for import path %s', (path) => {
    expect(scope(path).run_import_reference).toBe(true);
  });
  it.each([
    'apps/api/src/auth/auth.service.ts',
    'apps/admin/src/screens/admin/imports/import-run-page.tsx',
  ])('leaves the reference imports to the nightly run for %s', (path) => {
    expect(scope(path).run_import_reference).toBe(false);
  });
  it('fails closed for empty or incomplete file lists', () => {
    expect(classifyChanges([], 0, workspaces).run_full).toBe(true);
    expect(classifyChanges([{ filename: 'README.md' }], 3001, workspaces).run_full).toBe(true);
  });
});
