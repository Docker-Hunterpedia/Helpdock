import { tokens } from './tokens.js';
import type { ThemeMode } from './tokens.schema.js';

const PREFIX = '--hd';
const INDENT = '  ';

export interface TokensToCssOptions {
  readonly mode: ThemeMode;
  /**
   * `all` emits every token, so one block is enough to style a document.
   * `mode` emits only the tokens that differ between light and dark, which is
   * what a dark-mode override block needs.
   */
  readonly include?: 'all' | 'mode';
  readonly indent?: string;
}

/** `bodyLg` and `bg.canvas` both become `body-lg` / `bg-canvas`. */
const toCssName = (name: string): string =>
  name.replace(/\./g, '-').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const declaration = (name: string, value: string | number): string =>
  `${PREFIX}-${toCssName(name)}: ${value};`;

function modeDeclarations(mode: ThemeMode): string[] {
  const lines = Object.entries(tokens.semantic[mode]).map(([name, value]) =>
    declaration(name, value),
  );

  for (const [level, shadow] of Object.entries(tokens.elevation[mode])) {
    lines.push(declaration(`elevation-${level}`, shadow));
  }

  return lines;
}

function staticDeclarations(): string[] {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(tokens.radius)) {
    lines.push(declaration(`radius-${name}`, `${value}px`));
  }
  for (const step of tokens.spacing.scale) {
    lines.push(declaration(`space-${step}`, `${step}px`));
  }
  for (const [name, value] of Object.entries(tokens.typography.fontFamily)) {
    lines.push(declaration(`font-${name}`, value));
  }
  for (const [name, value] of Object.entries(tokens.typography.fontWeight)) {
    lines.push(declaration(`weight-${name}`, value));
  }
  for (const [name, style] of Object.entries(tokens.typography.scale)) {
    lines.push(declaration(`type-${name}-size`, `${style.size}px`));
    lines.push(declaration(`type-${name}-line`, `${style.lineHeight}px`));
    lines.push(declaration(`type-${name}-weight`, style.weight));
  }
  for (const [name, value] of Object.entries(tokens.motion.duration)) {
    lines.push(declaration(`duration-${name}`, `${value}ms`));
  }
  for (const [name, value] of Object.entries(tokens.motion.easing)) {
    lines.push(declaration(`ease-${name}`, value));
  }
  lines.push(declaration('focus-width', `${tokens.focus.width}px`));
  lines.push(declaration('focus-offset', `${tokens.focus.offset}px`));
  lines.push(declaration('focus-style', tokens.focus.style));

  return lines;
}

/**
 * The tokens as `--hd-*` custom property declarations, without a selector.
 * The widget and the help center style themselves from these instead of the
 * MUI theme (DESIGN §11).
 */
export function tokensToCss({
  mode,
  include = 'all',
  indent = INDENT,
}: TokensToCssOptions): string {
  const lines =
    include === 'mode'
      ? modeDeclarations(mode)
      : [...modeDeclarations(mode), ...staticDeclarations()];

  return lines.map((line) => `${indent}${line}`).join('\n');
}

/**
 * A ready-to-serve stylesheet: light on `:root`, dark under
 * `prefers-color-scheme` unless the document opted into light, and dark again
 * for an explicit `data-theme="dark"`.
 */
export function tokensCssBundle(): string {
  const light = tokensToCss({ mode: 'light' });
  const dark = tokensToCss({ mode: 'dark', include: 'mode', indent: INDENT.repeat(2) });
  const darkTopLevel = tokensToCss({ mode: 'dark', include: 'mode' });

  return [
    ':root {',
    light,
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    `${INDENT}:root:not([data-theme="light"]) {`,
    dark,
    `${INDENT}}`,
    '}',
    '',
    ':root[data-theme="dark"] {',
    darkTopLevel,
    '}',
    '',
  ].join('\n');
}
