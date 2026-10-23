/**
 * Why this exists: the 1.0 UX review (finding UX-04) caught admin screens
 * printing dates through a bare `toLocaleDateString()`, which follows the
 * browser's locale instead of the app's — Arabic-Indic digits in `ar`, against
 * DESIGN §7 — and PR #244 routed every call through `apps/admin/src/ui/format.ts`.
 * This check keeps the bug class out: it refuses a bare call to `toLocaleString`,
 * `toLocaleDateString`, `toLocaleTimeString`, `toLocaleLowerCase` or
 * `toLocaleUpperCase` — one with no locale argument — in `apps/admin/src`.
 * Dates and numbers go through `ui/format.ts`; case folding uses the
 * locale-independent `toLowerCase`/`toUpperCase`, or passes an explicit locale.
 *
 * Deliberately a lexical scan rather than a parse, like `check-app-boundaries.ts`:
 * it only has to recognise a call with an empty argument list, or `undefined`
 * passed as the only argument. A match written inside a string or a comment can
 * produce a false positive, which fails loudly instead of passing silently.
 *
 * Run with `pnpm check:locale-args`. Exits non-zero and lists every bare call.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

/** The app whose screens this guards, per UX-04. */
const GUARDED_APP = 'admin';

/** Where date and number formatting lives, named by the diagnostic. */
const FORMAT_HELPER = `apps/${GUARDED_APP}/src/ui/format.ts`;

/** The date and number formatters the issue names; a bare call must go through `ui/format.ts`. */
const FORMAT_METHODS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
/** The case folders, where the deterministic alternative is the plain method. */
const CASE_METHODS = new Set(['toLocaleLowerCase', 'toLocaleUpperCase']);

/** The locale-independent case folder each `toLocale` one folds through. */
const PLAIN_CASE_METHOD = {
  toLocaleLowerCase: 'toLowerCase',
  toLocaleUpperCase: 'toUpperCase',
} as const;

export const LOCALE_METHODS = [...FORMAT_METHODS, ...CASE_METHODS] as const;

export type LocaleMethod = (typeof LOCALE_METHODS)[number];

export interface BareLocaleCall {
  /** The method as written, e.g. `toLocaleDateString`. */
  readonly method: LocaleMethod;
  /** 1-based line of the call's member access. */
  readonly line: number;
  /** 1-based column of the call's member access. */
  readonly column: number;
}

export interface Violation {
  /** Repository-relative, POSIX-separated path of the file. */
  readonly file: string;
  readonly call: BareLocaleCall;
  /** The diagnostic a developer can act on without opening the rule. */
  readonly message: string;
}

/**
 * Matches `.method()` and `?.method()` where the argument list is empty or
 * holds `undefined` alone; any other argument counts as an explicit locale.
 */
const BARE_CALL_PATTERN = new RegExp(
  `\\??\\.(${LOCALE_METHODS.join('|')})\\s*\\(\\s*(?:undefined\\s*)?\\)`,
  'g',
);

/** Finds the bare `toLocale*` calls in one source file, wherever it lives. */
export function findBareLocaleCalls(source: string): BareLocaleCall[] {
  const calls: BareLocaleCall[] = [];

  for (const match of source.matchAll(BARE_CALL_PATTERN)) {
    const method = match[1];
    if (method === undefined) {
      continue;
    }

    const uptoMatch = source.slice(0, match.index);
    const lineStart = uptoMatch.lastIndexOf('\n') + 1;
    // Point past an optional chain's `?`, at the member access itself.
    const memberAccess = match.index + (match[0].startsWith('?') ? 1 : 0);

    calls.push({
      method: method as LocaleMethod,
      line: (uptoMatch.match(/\n/g)?.length ?? 0) + 1,
      column: memberAccess - lineStart + 1,
    });
  }

  return calls;
}

function messageFor(method: LocaleMethod): string {
  if (FORMAT_METHODS.has(method)) {
    return `\`${method}()\` with no locale follows the browser's locale, not the app's (DESIGN §7, UX-04): format dates and numbers through \`${FORMAT_HELPER}\`, or pass an explicit locale such as \`${method}('en-US')\``;
  }

  const plain = PLAIN_CASE_METHOD[method as keyof typeof PLAIN_CASE_METHOD];
  return `\`${method}()\` with no locale follows the host's locale and folds differently per browser: use the locale-independent \`${plain}()\`, or pass an explicit locale`;
}

/** Returns the violations in one file; only `apps/admin/src` is guarded. */
export function findViolations(params: {
  readonly file: string;
  readonly source: string;
}): Violation[] {
  const [top, app, src] = params.file.split('/');
  if (top !== 'apps' || app !== GUARDED_APP || src !== 'src') {
    return [];
  }

  return findBareLocaleCalls(params.source).map((call) => ({
    file: params.file,
    call,
    message: messageFor(call.method),
  }));
}

async function collectSourceFiles(directory: string, repoRoot: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await collectSourceFiles(absolute, repoRoot)));
      }
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.relative(repoRoot, absolute).split(path.sep).join('/'));
    }
  }

  return files;
}

function formatViolation(violation: Violation): string {
  return `  ${violation.file}:${violation.call.line}:${violation.call.column}: ${violation.message}`;
}

async function scanAdmin(repoRoot: string): Promise<{ files: string[]; violations: Violation[] }> {
  const guardedRoot = path.join(repoRoot, 'apps', GUARDED_APP, 'src');
  const files = await collectSourceFiles(guardedRoot, repoRoot);
  const violations: Violation[] = [];

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    violations.push(...findViolations({ file, source }));
  }

  return { files, violations };
}

async function main(): Promise<void> {
  const { files, violations } = await scanAdmin(path.resolve(import.meta.dirname, '..'));

  if (violations.length > 0) {
    console.error(
      [
        `A bare toLocale* call in apps/${GUARDED_APP}/src follows the browser's locale instead of the app's`,
        `(DESIGN §7, UX-04). Dates and numbers go through ${FORMAT_HELPER}; case folding uses the`,
        'locale-independent toLowerCase/toUpperCase, or pass an explicit locale.',
        ...violations.map(formatViolation),
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `locale arguments: ${files.length} files in apps/${GUARDED_APP}/src checked, no bare calls`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === import.meta.filename) {
  await main();
}
