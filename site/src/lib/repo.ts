import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTagDates } from './changelog.ts';
import { resolveVersion } from './version.ts';

/** The repository root, given the website's own root (`site/`). */
export const repoRoot = (siteRoot: URL) => new URL('../', siteRoot);

export function readRepoFile(siteRoot: URL, path: string): string {
  return readFileSync(new URL(path, repoRoot(siteRoot)), 'utf8');
}

/** The release the site describes; see resolveVersion for the rules. */
export function releaseVersion(siteRoot: URL): string {
  const api = JSON.parse(readRepoFile(siteRoot, 'apps/api/package.json')) as { version: string };
  return resolveVersion(process.env.HELPDOCK_VERSION, api.version);
}

/** Release tag dates from git; empty when the checkout carries no tags. */
export function readTagDates(siteRoot: URL): Map<string, string> {
  try {
    const output = execFileSync(
      'git',
      ['for-each-ref', 'refs/tags/v*', '--format=%(refname:short) %(creatordate:short)'],
      { cwd: fileURLToPath(repoRoot(siteRoot)), encoding: 'utf8' },
    );
    return parseTagDates(output);
  } catch {
    return new Map();
  }
}
