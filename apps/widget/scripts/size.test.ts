// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUDGET, ENTRY, measure, overBudget } from './budget.ts';

describe('overBudget', () => {
  const entry = (gzipBytes: number) => ({ name: ENTRY, gzipBytes });

  it('passes a build inside every cap', () => {
    expect(overBudget([entry(BUDGET.entryBytes), { name: 'chunks/a.js', gzipBytes: 1 }])).toEqual(
      [],
    );
  });

  it('fails an entry one byte over 40 KB', () => {
    expect(overBudget([entry(BUDGET.entryBytes + 1)])).toEqual([
      expect.stringContaining('widget.js is 40.00 KB'),
    ]);
  });

  it('fails a lazy chunk over 20 KB and lazy chunks over 100 KB in total', () => {
    const chunks = Array.from({ length: 6 }, (_, index) => ({
      name: `chunks/${index}.js`,
      gzipBytes: 18 * 1024,
    }));

    expect(overBudget([entry(1), ...chunks])).toEqual([
      expect.stringContaining('the lazy chunks total 108.00 KB'),
    ]);
    expect(
      overBudget([entry(1), { name: 'chunks/big.js', gzipBytes: BUDGET.chunkBytes + 1 }]),
    ).toHaveLength(1);
  });

  it('fails a build without widget.js', () => {
    expect(overBudget([])).toEqual(['widget.js is missing from the build']);
  });
});

/**
 * The CI gate for M4-01: the real production build, measured. It runs in the
 * `unit` job with every other widget test.
 */
describe('the production build', () => {
  let outDir = '';

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'helpdock-widget-'));
    await build({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      root: fileURLToPath(new URL('..', import.meta.url)),
      logLevel: 'silent',
      build: { outDir, sourcemap: false },
    });
  }, 120_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('emits widget.js plus lazy chunks, and stays within DOMAIN-RULES §14', async () => {
    const files = await measure(outDir);

    expect(files.map((file) => file.name)).toContain(ENTRY);
    expect(files.filter((file) => file.name.startsWith('chunks/')).length).toBeGreaterThan(0);
    expect(overBudget(files)).toEqual([]);
  });
});
