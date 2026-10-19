import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Workspace = { name: string; path: string; dependencies: string[] };
type ChangedFile = { filename: string; previous_filename?: string; patch?: string };

// The 500-ticket vendor reference imports are the slowest suites (15–30 minutes).
// Pull requests run them only when the import path or what it writes through changes;
// the nightly full run covers everything else.
const IMPORT_PATHS = [
  /^apps\/api\/src\/imports\//,
  /^apps\/api\/src\/media\//,
  /^apps\/api\/src\/testing\/(native-reference|import-browser|vendor-lookup)/,
  /^apps\/api\/src\/.*\/import(ed)?[-.]/,
  /^packages\/importers\//,
  /^packages\/jobs\/src\//,
  /^packages\/db\/(drizzle|src\/schema)\//,
  /^packages\/schemas\/src\/import/,
];

// Guides a package test renders and compares, so a hand edit fails that package's suite.
const CHECKED_DOCS: Record<string, string> = {
  'docs/guides/configuration.md': '@helpdock/config',
  'docs/guides/webhooks.md': '@helpdock/jobs',
};

/** A release PR only bumps `"version"`; that cannot change what any suite tests. */
function versionBumpOnly(file: ChangedFile): boolean {
  if (!file.filename.endsWith('package.json') || file.previous_filename || !file.patch)
    return false;
  const changed = file.patch
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  return changed.length > 0 && changed.every((line) => /^[+-]\s*"version": "[^"]+",?$/.test(line));
}

export function readWorkspaces(root: string): Workspace[] {
  return ['apps', 'packages'].flatMap((area) =>
    readdirSync(resolve(root, area), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = `${area}/${entry.name}`;
        const manifest = JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8'));
        return {
          name: manifest.name as string,
          path,
          dependencies: Object.keys({
            ...manifest.dependencies,
            ...manifest.devDependencies,
            ...manifest.peerDependencies,
          }),
        };
      }),
  );
}

export function classifyChanges(
  files: ChangedFile[],
  expectedCount: number,
  workspaces: Workspace[],
) {
  const affected = new Set<string>();
  let full = files.length === 0 || files.length !== expectedCount;
  let imports = false;
  for (const file of files) {
    if (versionBumpOnly(file)) continue;
    for (const path of [file.filename, file.previous_filename].filter(Boolean) as string[]) {
      const checkedBy = CHECKED_DOCS[path];
      if (checkedBy) {
        affected.add(checkedBy);
        continue;
      }
      // Documentation does not alter runtime contracts; unknown paths fail closed.
      if (path.startsWith('docs/') || path.endsWith('.md')) continue;
      if (IMPORT_PATHS.some((pattern) => pattern.test(path))) imports = true;
      const workspace = workspaces.find((item) => path.startsWith(`${item.path}/`));
      if (workspace && !path.endsWith('/package.json')) affected.add(workspace.name);
      else full = true;
    }
  }
  // Include transitive consumers, including dev/peer dependencies used by tests.
  let changed = true;
  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      if (
        !affected.has(workspace.name) &&
        workspace.dependencies.some((name) => affected.has(name))
      ) {
        affected.add(workspace.name);
        changed = true;
      }
    }
  }
  const has = (name: string) => full || affected.has(`@helpdock/${name}`);
  const packages =
    full || workspaces.some((item) => item.path.startsWith('packages/') && affected.has(item.name));
  const code = full || affected.size > 0;
  return {
    run_full: full,
    run_api: has('api'),
    run_import_reference: full || (imports && has('api')),
    run_admin: has('admin'),
    run_widget: has('widget'),
    run_unit: packages || has('widget') || has('helpcenter'),
    run_integration: packages,
    run_browser_api: has('api') || has('admin') || has('widget') || has('helpcenter'),
    run_image: code,
    run_semgrep: code,
    typecheck_filters: JSON.stringify(
      workspaces.filter((item) => full || affected.has(item.name)).map((item) => item.name),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Expected a changed-file JSON path');
  const pages = JSON.parse(readFileSync(inputPath, 'utf8')) as ChangedFile[][];
  const scope = classifyChanges(
    pages.flat(),
    Number(process.argv[3]),
    readWorkspaces(process.cwd()),
  );
  for (const [key, value] of Object.entries(scope)) {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Actions script runs outside Turbo.
    appendFileSync(process.env.GITHUB_OUTPUT ?? '/dev/stdout', `${key}=${value}\n`);
  }
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Actions script runs outside Turbo.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      `### Affected CI suites\n\n${Object.entries(scope)
        .map(([key, value]) => `- ${key}: ${value}`)
        .join('\n')}\n`,
    );
  }
}
