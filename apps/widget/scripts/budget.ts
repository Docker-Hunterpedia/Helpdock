import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * DOMAIN-RULES §14: the initial `widget.js` is ≤ 40 KB gzipped; each lazy
 * chunk ≤ 20 KB and all of them together ≤ 100 KB. Source maps do not count;
 * browsers fetch them only with dev tools open.
 */
export const BUDGET = {
  entryBytes: 40 * 1024,
  chunkBytes: 20 * 1024,
  chunksTotalBytes: 100 * 1024,
} as const;

export const ENTRY = 'widget.js';

export interface BuiltFile {
  readonly name: string;
  readonly gzipBytes: number;
}

export async function measure(distDir: string): Promise<BuiltFile[]> {
  const names = (await readdir(distDir, { recursive: true })).filter((name) =>
    name.endsWith('.js'),
  );
  return Promise.all(
    names.map(async (name) => ({
      name: name.split(path.sep).join('/'),
      gzipBytes: gzipSync(await readFile(path.join(distDir, name)), { level: 9 }).length,
    })),
  );
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} KB`;

/** Every way the build is over budget, one line each; empty when it fits. */
export function overBudget(files: readonly BuiltFile[]): string[] {
  const problems: string[] = [];
  const entry = files.find((file) => file.name === ENTRY);
  const chunks = files.filter((file) => file.name !== ENTRY);

  if (!entry) {
    problems.push(`${ENTRY} is missing from the build`);
  } else if (entry.gzipBytes > BUDGET.entryBytes) {
    problems.push(
      `${ENTRY} is ${kb(entry.gzipBytes)} gzipped; the budget is ${kb(BUDGET.entryBytes)}`,
    );
  }
  for (const chunk of chunks) {
    if (chunk.gzipBytes > BUDGET.chunkBytes) {
      problems.push(
        `${chunk.name} is ${kb(chunk.gzipBytes)} gzipped; a lazy chunk may be ${kb(BUDGET.chunkBytes)}`,
      );
    }
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
  if (total > BUDGET.chunksTotalBytes) {
    problems.push(
      `the lazy chunks total ${kb(total)} gzipped; the budget is ${kb(BUDGET.chunksTotalBytes)}`,
    );
  }
  return problems;
}

export function report(files: readonly BuiltFile[]): string {
  return [...files]
    .sort((a, b) => (a.name === ENTRY ? -1 : b.name === ENTRY ? 1 : a.name.localeCompare(b.name)))
    .map((file) => `${kb(file.gzipBytes).padStart(10)}  ${file.name}`)
    .join('\n');
}
