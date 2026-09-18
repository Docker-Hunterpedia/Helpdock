/**
 * Enforces the layout rule in ARCHITECTURE §2: `apps/*` never import each other,
 * they share code only through `packages/*`.
 *
 * Run with `pnpm check:boundaries`. Exits non-zero and lists every offending
 * import when the rule is broken.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Violation {
  /** Repository-relative, POSIX-separated path of the importing file. */
  readonly file: string;
  /** App the importing file belongs to. */
  readonly app: string;
  /** App it reached into. */
  readonly targetApp: string;
  /** The module specifier as written. */
  readonly specifier: string;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);
const WORKSPACE_SCOPE = '@helpdock/';

/**
 * Deliberately a lexical scan rather than a parse: it only has to recognise the
 * specifier forms the apps use. A specifier written inside a string or a comment
 * can produce a false positive, which fails loudly instead of passing silently.
 */
const SPECIFIER_PATTERN =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

export function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

/** Returns the app a repository-relative path belongs to, or undefined. */
export function appOfPath(relativePath: string): string | undefined {
  const [top, app] = relativePath.split('/');
  return top === 'apps' ? app : undefined;
}

function resolveTargetApp(
  specifier: string,
  filePath: string,
  appNames: readonly string[],
): string | undefined {
  if (specifier.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), specifier));
    return appOfPath(resolved);
  }

  if (!specifier.startsWith(WORKSPACE_SCOPE)) {
    return undefined;
  }

  const [name] = specifier.slice(WORKSPACE_SCOPE.length).split('/');
  return name !== undefined && appNames.includes(name) ? name : undefined;
}

export function findViolations(params: {
  readonly file: string;
  readonly source: string;
  readonly appNames: readonly string[];
}): Violation[] {
  const app = appOfPath(params.file);
  if (app === undefined) {
    return [];
  }

  const violations: Violation[] = [];

  for (const specifier of extractSpecifiers(params.source)) {
    const targetApp = resolveTargetApp(specifier, params.file, params.appNames);
    if (targetApp !== undefined && targetApp !== app) {
      violations.push({ file: params.file, app, targetApp, specifier });
    }
  }

  return violations;
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
  return `  ${violation.file}: imports '${violation.specifier}' from apps/${violation.targetApp}`;
}

async function scanApps(repoRoot: string): Promise<{ files: string[]; violations: Violation[] }> {
  const appsRoot = path.join(repoRoot, 'apps');

  const appNames = (await readdir(appsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const files = await collectSourceFiles(appsRoot, repoRoot);
  const violations: Violation[] = [];

  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    violations.push(...findViolations({ file, source, appNames }));
  }

  return { files, violations };
}

async function main(): Promise<void> {
  const { files, violations } = await scanApps(path.resolve(import.meta.dirname, '..'));

  if (violations.length > 0) {
    console.error(
      `apps/* must not import each other; they share code through packages/* only.\n${violations
        .map(formatViolation)
        .join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`app import boundaries: ${files.length} files checked, no violations`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === import.meta.filename) {
  await main();
}
