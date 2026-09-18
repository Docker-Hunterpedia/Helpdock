import { describe, expect, it } from 'vitest';
import { tokensCssBundle, tokensToCss } from './css.js';
import { tokens } from './tokens.js';
import { SEMANTIC_TOKEN_NAMES } from './tokens.schema.js';

const customPropertyName = (token: string): string => `--hd-${token.replace(/\./g, '-')}`;

describe('tokensToCss', () => {
  it('emits one --hd-* declaration per semantic token', () => {
    const css = tokensToCss({ mode: 'light' });

    for (const name of SEMANTIC_TOKEN_NAMES) {
      expect(css).toContain(`${customPropertyName(name)}: ${tokens.semantic.light[name]};`);
    }
  });

  it('switches the mode-dependent values', () => {
    const dark = tokensToCss({ mode: 'dark' });

    expect(dark).toContain(`--hd-bg-canvas: ${tokens.semantic.dark['bg.canvas']};`);
    expect(dark).not.toContain(tokens.semantic.light['bg.canvas']);
  });

  it('kebab-cases the camel-cased token names', () => {
    const css = tokensToCss({ mode: 'light' });

    expect(css).toContain('--hd-type-body-lg-size: 16px;');
    expect(css).toContain('--hd-type-body-strong-weight: 500;');
  });

  it('carries the scales the widget needs beside the colours', () => {
    const css = tokensToCss({ mode: 'light' });

    expect(css).toContain('--hd-radius-lg: 10px;');
    expect(css).toContain('--hd-space-24: 24px;');
    expect(css).toContain('--hd-duration-fast: 120ms;');
    expect(css).toContain('--hd-focus-width: 2px;');
    expect(css).toContain(`--hd-font-mono: ${tokens.typography.fontFamily.mono};`);
  });

  it('leaves the scales out of a mode-only block, so a dark override stays small', () => {
    const modeOnly = tokensToCss({ mode: 'dark', include: 'mode' });

    expect(modeOnly).toContain('--hd-bg-canvas');
    expect(modeOnly).toContain('--hd-elevation-3');
    expect(modeOnly).not.toContain('--hd-radius-lg');
  });
});

describe('tokensCssBundle', () => {
  it('puts light on :root and dark behind both the query and the attribute', () => {
    const bundle = tokensCssBundle();

    expect(bundle).toContain(':root {');
    expect(bundle).toContain('@media (prefers-color-scheme: dark) {');
    expect(bundle).toContain(':root:not([data-theme="light"]) {');
    expect(bundle).toContain(':root[data-theme="dark"] {');
  });

  it('balances its braces', () => {
    const bundle = tokensCssBundle();

    expect(bundle.split('{')).toHaveLength(bundle.split('}').length);
  });

  it('matches the published stylesheet', () => {
    expect(tokensCssBundle()).toMatchSnapshot();
  });
});
