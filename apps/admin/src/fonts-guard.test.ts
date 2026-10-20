import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tokens } from '@helpdock/ui';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const scale = new Set(Object.values(tokens.typography.scale).map(({ size }) => size));
scale.add(tokens.typography.baseSize.admin);

// This lexical guard covers literal declarations, all string literals and literal
// branches of conditional/template sizes. It does not resolve identifiers, spreads,
// function calls or arithmetic, or parse arbitrary nested JS/CSS expressions.
function withoutComments(source: string): string {
  return source.replace(
    /(['"`])(?:\\.|(?!\1)[\s\S])*?\1|\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[dgimsuvy]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (/^\/(?:\*|\/)/.test(match) ? '' : match),
  );
}

function invalidFamilies(source: string): string[] {
  const declarations = withoutComments(source);
  const copiedStacks = Array.from(
    declarations.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g),
    (match) => match[2] ?? '',
  ).filter(
    (value) =>
      /IBM Plex|(?<!\/)\b(?:Arial|Helvetica|Menlo|Monaco|Consolas|Courier New|Times New Roman|Segoe UI)\b/.test(
        value,
      ) ||
      /(?:['"][^'"\n]+['"]|\b(?:ui-sans-serif|ui-monospace|system-ui|sans-serif|monospace|serif))\s*,[^;\n]*\b(?:sans-serif|monospace|serif|system-ui)\b/.test(
        value,
      ),
  );
  const values = [
    ...copiedStacks,
    ...Array.from(
      declarations.matchAll(/\bfontFamily\s*(?::|=)\s*\{?\s*(['"`])(.*?)\1/g),
      (match) => match[2] ?? '',
    ),
    ...Array.from(
      declarations.matchAll(/\bfont-family\s*:\s*((?:\$\{[^}]+\}|[^;}\n])+)/g),
      (match) => (match[1] ?? '').split(/["']>/)[0] ?? '',
    ),
    ...Array.from(
      declarations.matchAll(/\bfont\s*:\s*(['"`])?(\d[^;\n}]*|(?:italic|normal|bold)\s+[^;\n}]+)/g),
      (match) =>
        (match[2] ?? '')
          .replace(/['"`,]+$/, '')
          .replace(/^.*?\d+(?:px|rem|em|%)\s*(?:\/\s*[\d.]+(?:px|rem|em|%)?\s*)?\s+/, ''),
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
  const sizes: number[] = [];
  for (const declaration of withoutComments(source).matchAll(
    /\b(?:fontSize\s*(?::|=)|font-size\s*:)\s*([^,;\n]+)/g,
  )) {
    const expression = declaration[1] ?? '';
    for (const literal of expression.matchAll(
      /(?:^\s*[{\s'"`]*|[?:]\s*['"`]?|\$\{\s*)(\d+(?:\.\d+)?)(?=px|rem|em|%|[\s'"`}?:]|$)/g,
    )) {
      sizes.push(Number(literal[1]));
    }
  }
  return sizes.filter((size) => !scale.has(size));
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
    'fontFamily: `Arial`',
    'fontFamily={`monospace`}',
    'font: 14px/20px Arial;',
    'font: "italic 14px Arial"',
    'font-family: "Some New Font";',
    'const MONO = "\'IBM Plex Mono\', ui-monospace, monospace";',
    'const SANS = "system-ui, sans-serif";',
    `font_family: { sans: "'IBM Plex Sans', system-ui, sans-serif" }`,
    `const SANS: Record<Locale, string> = { en: "'IBM Plex Sans', system-ui, sans-serif" }`,
    'const MONO: string = "Menlo";',
    "fontFamily: isCode ? 'Menlo' : 'inherit'",
    `const stack = "'Some New Font', sans-serif";`,
    `const pattern = /[//]/; const MONO: string = "Consolas";`,
  ])('rejects literal family declaration %s', (source) => {
    expect(invalidFamilies(source).length).toBeGreaterThan(0);
  });

  // Original #339 regressions: widget config object and staff-email locale map.
  it.each([
    [
      'widget fixture',
      `font_family: {
        sans: "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        arabic: "'IBM Plex Sans Arabic', 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
        mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      }`,
    ],
    [
      'staff email',
      `const SANS: Record<Locale, string> = { en: "'IBM Plex Sans', system-ui, sans-serif", ar: "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif" }; const MONO = "'IBM Plex Mono', ui-monospace, monospace";`,
    ],
  ])('rejects the old %s font patterns', (_label, source) => {
    expect(invalidFamilies(source).length).toBeGreaterThan(0);
  });

  it.each([
    "fontFamily: 'inherit'",
    "fontFamily: 'var(--hd-font-mono)'",
    'font-family: var(--hd-font-arabic);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    'font-family:${escapeHtml(fontFallbacks.sans)};',
    'fontFamily: theme.typography.mono.fontFamily',
    'fontFamily: tokens.typography.fontFamily.sans',
    '// fontFamily: "monospace"',
    '/* font-family: sans-serif; */',
    '<p>The "monospace" and sans-serif families</p>',
    'font: 14px/20px var(--hd-font-sans);',
    "const help = 'Pick a monospace font';",
    "const pdfFont = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';",
    'const pattern = /[//]/; // fontFamily: "Arial"',
    'const pattern = /https?:\\/\\//; /* fontFamily: "Arial" */',
  ])('accepts token or inherited declaration %s', (source) => {
    expect(invalidFamilies(source)).toEqual([]);
  });

  it.each([
    'font-size: 1em;',
    'font-size: 100%;',
    'fontSize: 11',
    'fontSize: "18px"',
    'font-size: 15px;',
    'fontSize={18}',
    'fontSize: `18px`',
    'fontSize: compact ? 11 : 14',
    'fontSize={compact ? 14 : 18}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    'font-size: ${compact ? 15 : 14}px;',
  ])('rejects off-scale size %s', (source) => {
    expect(invalidSizes(source)).toHaveLength(1);
  });

  it.each([
    'fontSize: 14',
    'fontSize: compact ? 12 : 14',
    'fontSize: `14px`',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    'font-size: ${compact ? 12 : 14}px;',
  ])('accepts on-scale size %s', (source) => {
    expect(invalidSizes(source)).toEqual([]);
  });

  it('keeps application and package fonts shared and admin sizes on the scale', async () => {
    const failures: string[] = [];
    for (const group of ['apps', 'packages']) {
      const directory = path.join(root, group);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.filter((entry) => entry.isDirectory())) {
        if (group === 'packages' && entry.name === 'ui') continue;
        for (const file of await sourceFiles(path.join(directory, entry.name, 'src'))) {
          const source = await readFile(file, 'utf8');
          const families = invalidFamilies(source);
          const sizes = group === 'apps' && entry.name === 'admin' ? invalidSizes(source) : [];
          if (families.length || sizes.length) {
            failures.push(
              `${path.relative(root, file)}: families=${families.join('; ')} sizes=${sizes.join(', ')}`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
