import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tokens } from '@helpdock/ui';
import { describe, expect, it } from 'vitest';

const apps = path.resolve(import.meta.dirname, '../..');
const scale = new Set(Object.values(tokens.typography.scale).map(({ size }) => size));
scale.add(tokens.typography.baseSize.admin);

// Scan declarations, including inline CSS in server-rendered HTML. An inherited
// face is fine; a CSS variable must never hide a literal fallback (#339).
function invalidFamilies(source: string): string[] {
  // Also catch a copied stack hidden in a local constant or mock config,
  // rather than only the declaration that later interpolates it.
  const copiedStacks = Array.from(
    source.matchAll(/(['"])((?:\\.|(?!\1)[^\n])*)\1/g),
    (match) => match[2] ?? '',
  ).filter((value) => /IBM Plex|\b(?:monospace|sans-serif|serif|system-ui)\b/.test(value));
  const values = [
    ...copiedStacks,
    ...Array.from(
      source.matchAll(/\bfontFamily\s*(?::|=)\s*(['"])(.*?)\1/g),
      (match) => match[2] ?? '',
    ),
    ...Array.from(
      source.matchAll(/\bfont-family\s*:\s*((?:\$\{[^}]+\}|[^;}\n])+)/g),
      (match) => (match[1] ?? '').split(/["']>/)[0] ?? '',
    ),
  ];
  return [...new Set(values)].filter((value) => {
    const family = value.trim();
    return (
      !/^(?:inherit|initial|unset|var\(--hd-font-[a-z-]+\))$/.test(family) &&
      !/^\$\{[^}]+\}$/.test(family)
    );
  });
}

function invalidSizes(source: string): number[] {
  return Array.from(
    source.matchAll(/\b(?:fontSize\s*(?::|=\s*\{?)\s*['"]?|font-size\s*:\s*)(\d+(?:\.\d+)?)/g),
    (match) => Number(match[1]),
  ).filter((size) => !scale.has(size));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(file);
      return /\.(?:tsx?|css)$/.test(file) && !/\.test\.[^.]+$/.test(file) ? [file] : [];
    }),
  );
  return nested.flat();
}

describe('font contract (#339)', () => {
  it.each([
    "fontFamily: 'Arial'",
    "fontFamily: 'monospace'",
    "fontFamily: 'var(--hd-font-mono, monospace)'",
    'font-family: sans-serif;',
    'fontFamily="Arial"',
    'font-family: "Some New Font";',
    'const MONO = "\'IBM Plex Mono\', ui-monospace, monospace";',
    'const SANS = "system-ui, sans-serif";',
  ])('rejects literal family declaration %s', (source) => {
    expect(invalidFamilies(source)).toHaveLength(1);
  });

  it.each([
    "fontFamily: 'inherit'",
    "fontFamily: 'var(--hd-font-mono)'",
    'font-family: var(--hd-font-arabic);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    'font-family:${escapeHtml(fontFallbacks.sans)};',
    'fontFamily: theme.typography.mono.fontFamily',
    'fontFamily: tokens.typography.fontFamily.sans',
  ])('accepts token or inherited declaration %s', (source) => {
    expect(invalidFamilies(source)).toEqual([]);
  });

  it.each(['fontSize: 11', 'fontSize: "18px"', 'font-size: 15px;', 'fontSize={18}'])(
    'rejects off-scale size %s',
    (source) => {
      expect(invalidSizes(source)).toHaveLength(1);
    },
  );

  it('keeps all application font declarations on shared families and admin sizes on the scale', async () => {
    const failures: string[] = [];
    for (const app of await readdir(apps)) {
      for (const file of await sourceFiles(path.join(apps, app, 'src'))) {
        const source = await readFile(file, 'utf8');
        const families = invalidFamilies(source);
        const sizes = app === 'admin' ? invalidSizes(source) : [];
        if (families.length || sizes.length) {
          failures.push(
            `${path.relative(apps, file)}: families=${families.join('; ')} sizes=${sizes.join(', ')}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
