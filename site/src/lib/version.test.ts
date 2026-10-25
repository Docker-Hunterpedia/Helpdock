import { describe, expect, it } from 'vitest';
import { compareReleasesDescending, resolveVersion } from './version.ts';

describe('resolveVersion', () => {
  it('uses the release the Pages workflow passes, with or without its v', () => {
    expect(resolveVersion('1.2.0', '1.3.0')).toBe('1.2.0');
    expect(resolveVersion('v1.2.0', '1.3.0')).toBe('1.2.0');
  });

  it('falls back to the @helpdock/api version when nothing is passed', () => {
    expect(resolveVersion(undefined, '1.2.0')).toBe('1.2.0');
  });

  it.each(['', 'latest', '1.2', '1.2.0-rc.1', '01.2.0', '1.2.0.1'])(
    'fails the build on a passed value of "%s" rather than guess',
    (value) => {
      expect(() => resolveVersion(value, '1.2.0')).toThrow(/not a plain x\.y\.z/);
    },
  );

  it('fails when the package version is a prerelease', () => {
    expect(() => resolveVersion(undefined, '1.3.0-next.0')).toThrow(/not a plain x\.y\.z/);
  });
});

describe('compareReleasesDescending', () => {
  it('orders by number, not by text', () => {
    expect(['1.0.9', '1.0.10', '1.2.0', '0.7.0'].sort(compareReleasesDescending)).toEqual([
      '1.2.0',
      '1.0.10',
      '1.0.9',
      '0.7.0',
    ]);
  });
});
