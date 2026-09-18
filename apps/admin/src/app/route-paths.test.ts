import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNED_IN_ROUTE, safeReturnTo } from './route-paths.js';

describe('safeReturnTo', () => {
  it('keeps a path inside the app', () => {
    expect(safeReturnTo('/admin/settings?tab=email')).toBe('/admin/settings?tab=email');
  });

  it.each([
    ['nothing', null],
    ['an empty value', ''],
    ['an absolute url', 'https://evil.example/steal'],
    ['a protocol-relative url', '//evil.example'],
    ['a relative path', 'admin/settings'],
  ])('falls back to the default screen for %s', (_case, value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_SIGNED_IN_ROUTE);
  });
});
