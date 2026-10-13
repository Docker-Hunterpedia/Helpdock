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
  it('fails closed for empty or incomplete file lists', () => {
    expect(classifyChanges([], 0, workspaces).run_full).toBe(true);
    expect(classifyChanges([{ filename: 'README.md' }], 3001, workspaces).run_full).toBe(true);
  });
});
