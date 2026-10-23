import { describe, expect, it } from 'vitest';
import { findBareLocaleCalls, findViolations } from './check-locale-args.ts';

const violationsIn = (file: string, source: string) => findViolations({ file, source });

describe('findBareLocaleCalls', () => {
  it('finds a bare call on each format and case method', () => {
    const source = [
      'const a = total.toLocaleString();',
      'const b = day.toLocaleDateString();',
      'const c = time.toLocaleTimeString();',
      'const d = name.toLocaleLowerCase();',
      'const e = name.toLocaleUpperCase();',
    ].join('\n');

    expect(findBareLocaleCalls(source).map((call) => call.method)).toEqual([
      'toLocaleString',
      'toLocaleDateString',
      'toLocaleTimeString',
      'toLocaleLowerCase',
      'toLocaleUpperCase',
    ]);
  });

  it('allows a call with an explicit locale', () => {
    const source = [
      "const a = total.toLocaleString('en-US');",
      "const b = total.toLocaleString('en-US', { currency: 'USD' });",
      "const c = name.toLocaleLowerCase('en');",
    ].join('\n');

    expect(findBareLocaleCalls(source)).toEqual([]);
  });

  it('refuses undefined passed as the only argument, which is the same as no locale', () => {
    expect(findBareLocaleCalls('const a = day.toLocaleDateString(undefined);')).toHaveLength(1);
    expect(findBareLocaleCalls('const b = day.toLocaleDateString(undefined, {});')).toEqual([]);
  });

  it('reports the line and the column of the call', () => {
    const source = 'const total = 0;\n\nconst text = total.toLocaleString();';

    expect(findBareLocaleCalls(source)).toEqual([
      { method: 'toLocaleString', line: 3, column: 19 },
    ]);
  });

  it('finds optional-chained calls and points at the member access', () => {
    expect(findBareLocaleCalls('const a = total?.toLocaleString();')).toEqual([
      { method: 'toLocaleString', line: 1, column: 17 },
    ]);
  });

  it('finds every bare call in a file with several', () => {
    const source = 'const q = term.toLocaleLowerCase();\nconst n = name.toLocaleLowerCase();';

    expect(findBareLocaleCalls(source)).toHaveLength(2);
  });

  it('ignores a call whose first argument is a locale among other arguments', () => {
    expect(
      findBareLocaleCalls("const a = total.toLocaleString('ar-u-nu-latn', { useGrouping: true });"),
    ).toEqual([]);
  });

  it('ignores calls to unrelated methods', () => {
    expect(
      findBareLocaleCalls('const a = text.toString();\nconst b = Intl.NumberFormat();'),
    ).toEqual([]);
  });
});

describe('findViolations', () => {
  it('refuses a bare call in apps/admin/src', () => {
    const violations = violationsIn(
      'apps/admin/src/screens/staff.tsx',
      'const day = at.toLocaleDateString();',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.call).toEqual({ method: 'toLocaleDateString', line: 1, column: 15 });
    expect(violations[0]?.message).toContain('apps/admin/src/ui/format.ts');
  });

  it('refuses a bare case fold in apps/admin/src and names the plain method', () => {
    const violations = violationsIn(
      'apps/admin/src/tickets/tags.ts',
      'const needle = term.toLocaleLowerCase();',
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('`toLowerCase()`');
  });

  it('allows a call with an explicit locale in apps/admin/src', () => {
    expect(
      violationsIn(
        'apps/admin/src/screens/staff.tsx',
        "const n = row.searches.toLocaleString('en-US');",
      ),
    ).toEqual([]);
  });

  it('ignores files outside apps/admin/src', () => {
    const source = 'const day = at.toLocaleDateString();';

    expect(violationsIn('apps/admin/e2e/flows.ts', source)).toEqual([]);
    expect(violationsIn('apps/api/src/index.ts', source)).toEqual([]);
    expect(violationsIn('apps/helpcenter/src/page.tsx', source)).toEqual([]);
    expect(violationsIn('packages/schemas/src/rule-conditions.ts', source)).toEqual([]);
    expect(violationsIn('scripts/check-locale-args.ts', source)).toEqual([]);
  });

  it('ignores a nested path that is not directly under src', () => {
    expect(
      violationsIn('apps/admin/src-extra/notes.ts', 'const day = at.toLocaleDateString();'),
    ).toEqual([]);
  });
});
