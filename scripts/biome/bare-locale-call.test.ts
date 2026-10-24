import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BIOME = path.join(REPO_ROOT, 'node_modules', '.bin', 'biome');
const PLUGIN = path.join(REPO_ROOT, 'scripts', 'biome', 'bare-locale-call.grit');

/**
 * The rule is scoped by an override in biome.json, so the test builds a small
 * project with the same override and lints files placed inside and outside the
 * guarded folder. Linting the repo's own files would make `pnpm lint` fail on
 * the fixtures.
 */
let project: string;

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), 'bare-locale-call-'));
  writeFileSync(
    path.join(project, 'biome.json'),
    JSON.stringify({
      linter: { enabled: true, rules: { recommended: false } },
      overrides: [{ includes: ['apps/admin/src/**'], plugins: [PLUGIN] }],
    }),
  );
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
});

function lint(file: string, source: string): { flaggedLines: number[] } {
  const target = path.join(project, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);

  let output = '';
  try {
    execFileSync(BIOME, ['lint', '--colors=off', '--max-diagnostics=50', file], {
      cwd: project,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }

  const flaggedLines = [...output.matchAll(/^\S+:(\d+):\d+ plugin/gm)].map((match) =>
    Number(match[1]),
  );
  return { flaggedLines };
}

const ADMIN_FILE = 'apps/admin/src/format-me.ts';

describe('bare-locale-call plugin', () => {
  it.each([
    ['toLocaleString', 'date.toLocaleString()'],
    ['toLocaleDateString', 'date.toLocaleDateString()'],
    ['toLocaleTimeString', 'date.toLocaleTimeString()'],
    ['an optional call', 'date?.toLocaleDateString()'],
    ['a chained receiver', 'row.createdAt.toLocaleString()'],
  ])('flags %s with no arguments', (_name, call) => {
    expect(lint(ADMIN_FILE, `${call};\n`).flaggedLines).toEqual([1]);
  });

  it.each([
    ['toLocaleString', 'amount.toLocaleString(undefined)'],
    ['toLocaleDateString with options', "date.toLocaleDateString(undefined, { month: 'short' })"],
    ['toLocaleTimeString with options', 'date.toLocaleTimeString(undefined, options)'],
    ['an optional call', "date?.toLocaleString(undefined, { dateStyle: 'short' })"],
  ])('flags %s with undefined as the locale', (_name, call) => {
    expect(lint(ADMIN_FILE, `${call};\n`).flaggedLines).toEqual([1]);
  });

  it('reports each offending line of a file and no other', () => {
    const source = [
      "date.toLocaleDateString('en-US');",
      'date.toLocaleDateString();',
      'date.toLocaleString(locale, options);',
      "date.toLocaleTimeString(undefined, { hour: '2-digit' });",
      "date.toLocaleString(['ar', 'en']);",
    ].join('\n');

    expect(lint(ADMIN_FILE, source).flaggedLines).toEqual([2, 4]);
  });

  it('allows an explicit locale, a variable and an array of locales', () => {
    const source = [
      "date.toLocaleDateString('en-US');",
      'date.toLocaleString(locale);',
      "date.toLocaleTimeString(['ar', 'en'], { hour12: false });",
    ].join('\n');

    expect(lint(ADMIN_FILE, source).flaggedLines).toEqual([]);
  });

  it('leaves files outside apps/admin/src alone', () => {
    expect(lint('apps/api/src/format-me.ts', 'date.toLocaleDateString();\n').flaggedLines).toEqual(
      [],
    );
  });
});
