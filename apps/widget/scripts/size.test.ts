// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUDGET, ENTRY, measure, overBudget, TRANSPORT_CHUNK } from './budget.ts';

describe('overBudget', () => {
  const entry = (gzipBytes: number) => ({ name: ENTRY, gzipBytes });
  const transport = { name: 'chunks/remote-Cnr2-TYR.js', gzipBytes: 17 * 1024 };

  it('passes a build inside every cap', () => {
    expect(
      overBudget([entry(BUDGET.entryBytes), transport, { name: 'chunks/a.js', gzipBytes: 1 }]),
    ).toEqual([]);
  });

  it('fails an entry one byte over 40 KB', () => {
    expect(overBudget([entry(BUDGET.entryBytes + 1), transport])).toEqual([
      expect.stringContaining('widget.js is 40.00 KB'),
    ]);
  });

  it('fails a build whose transport is not a chunk of its own, or is over 20 KB', () => {
    expect(overBudget([entry(1)])).toEqual([
      'the transport is not a lazy chunk of its own (chunks/remote-*.js)',
    ]);
    expect(overBudget([entry(1), { ...transport, gzipBytes: BUDGET.chunkBytes + 1 }])).toEqual([
      expect.stringContaining('chunks/remote-Cnr2-TYR.js is 20.00 KB'),
    ]);
  });

  it('fails a lazy chunk over 20 KB and lazy chunks over 100 KB in total', () => {
    const chunks = Array.from({ length: 6 }, (_, index) => ({
      name: `chunks/${index}.js`,
      gzipBytes: 18 * 1024,
    }));

    expect(overBudget([entry(1), transport, ...chunks.slice(1)])).toEqual([
      expect.stringContaining('the lazy chunks total 107.00 KB'),
    ]);
    expect(
      overBudget([
        entry(1),
        transport,
        { name: 'chunks/big.js', gzipBytes: BUDGET.chunkBytes + 1 },
      ]),
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
    expect(files.some((file) => TRANSPORT_CHUNK.test(file.name))).toBe(true);
    expect(overBudget(files)).toEqual([]);
  });

  it('keeps socket.io-client out of widget.js', async () => {
    const entry = await readFile(path.join(outDir, ENTRY), 'utf8');

    expect(entry).not.toMatch(/engine\.io|socket\.io-client/i);
  });
});
