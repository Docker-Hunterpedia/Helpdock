import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The operations guide names every `rate_limit_refusals_total` bucket an
 * alert can be written against (ASVS 8.1.4). A limit added without its line
 * there is a refusal nobody knows to look for, so this reads the bucket names
 * out of the source, as `reference.test.ts` does for the configuration page.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const GUIDE = path.resolve(SRC, '../../../docs/guides/operations.md');

/** `bucket: 'name'` in a rule, and the SAML service's `this.limit('name', …)`. */
const BUCKET_PATTERNS = [/\bbucket: '([a-z0-9-]+)'/g, /\bthis\.limit\('([a-z0-9-]+)'/g];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'testing' ? [] : sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });

const bucketsInSource = (): string[] => {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of BUCKET_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.add(match[1] ?? '');
      }
    }
  }
  return [...found].sort();
};

describe('the rate_limit_refusals_total bucket list in the operations guide', () => {
  it('names every bucket a limit in the api counts under', () => {
    const row =
      readFileSync(GUIDE, 'utf8')
        .split('\n')
        .find((line) => line.startsWith('| `rate_limit_refusals_total`')) ?? '';
    const buckets = bucketsInSource();

    expect(buckets.length).toBeGreaterThan(20);
    expect(buckets.filter((bucket) => !row.includes(`\`${bucket}\``))).toEqual([]);
  });
});
