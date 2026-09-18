import { describe, expect, it } from 'vitest';
import { appOfPath, extractSpecifiers, findViolations } from './check-app-boundaries.ts';

const APP_NAMES = ['api', 'admin', 'helpcenter', 'widget'] as const;

function violationsIn(file: string, source: string) {
  return findViolations({ file, source, appNames: APP_NAMES });
}

describe('extractSpecifiers', () => {
  it('reads static, side-effect, dynamic and require specifiers', () => {
    const source = [
      "import { a } from '@helpdock/schemas';",
      "export { b } from './b.js';",
      "import 'reflect-metadata';",
      "const c = await import('node:fs');",
      "const d = require('./d.cjs');",
    ].join('\n');

    expect(extractSpecifiers(source)).toEqual([
      '@helpdock/schemas',
      './b.js',
      'reflect-metadata',
      'node:fs',
      './d.cjs',
    ]);
  });

  it('returns nothing for a file with no imports', () => {
    expect(extractSpecifiers('export const value = 1;\n')).toEqual([]);
  });
});

describe('appOfPath', () => {
  it('names the app a path belongs to', () => {
    expect(appOfPath('apps/api/src/index.ts')).toBe('api');
  });

  it('returns undefined outside apps/', () => {
    expect(appOfPath('packages/db/src/index.ts')).toBeUndefined();
    expect(appOfPath('scripts/check-app-boundaries.ts')).toBeUndefined();
  });
});

describe('findViolations', () => {
  it('rejects importing another app by workspace name', () => {
    const violations = violationsIn(
      'apps/api/src/index.ts',
      "import { PACKAGE_NAME } from '@helpdock/admin';",
    );

    expect(violations).toEqual([
      {
        file: 'apps/api/src/index.ts',
        app: 'api',
        targetApp: 'admin',
        specifier: '@helpdock/admin',
      },
    ]);
  });

  it('rejects reaching into another app with a relative path', () => {
    const violations = violationsIn(
      'apps/widget/src/nested/deep.ts',
      "import { theme } from '../../../helpcenter/src/theme.js';",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.targetApp).toBe('helpcenter');
  });

  it('allows importing a package by workspace name', () => {
    expect(violationsIn('apps/api/src/index.ts', "import '@helpdock/db';")).toEqual([]);
  });

  it('allows a relative path into packages/', () => {
    expect(
      violationsIn('apps/api/src/index.ts', "import '../../../packages/schemas/src/index.js';"),
    ).toEqual([]);
  });

  it('allows relative imports inside the same app', () => {
    expect(violationsIn('apps/admin/src/index.ts', "import './routes/home.js';")).toEqual([]);
  });

  it('allows external and node built-in imports', () => {
    expect(violationsIn('apps/api/src/index.ts', "import { join } from 'node:path';")).toEqual([]);
  });

  it('ignores a scoped package that is not an app', () => {
    expect(violationsIn('apps/api/src/index.ts', "import '@helpdock/channels/email';")).toEqual([]);
  });

  it('ignores files outside apps/', () => {
    expect(violationsIn('packages/ui/src/index.ts', "import '@helpdock/admin';")).toEqual([]);
  });

  it('reports every offending import in a file', () => {
    const violations = violationsIn(
      'apps/api/src/index.ts',
      ["import '@helpdock/admin';", "import '../../widget/src/index.js';"].join('\n'),
    );

    expect(violations.map((violation) => violation.targetApp)).toEqual(['admin', 'widget']);
  });
});
