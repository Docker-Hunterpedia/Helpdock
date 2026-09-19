import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildInfo, shortSha, UNKNOWN_GIT_SHA } from './build-info.js';

const manifestVersion = (): string =>
  (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;

describe('shortSha', () => {
  it('shortens a full sha to the form a person quotes', () => {
    expect(shortSha('a2cf2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d')).toBe('a2cf2b3');
  });

  it('accepts one that was already short, and lower-cases it', () => {
    expect(shortSha('A2CF2B3')).toBe('a2cf2b3');
  });

  it.each([
    ['nothing at all', undefined],
    ['an empty build argument', '   '],
    ['a branch name', 'main'],
    ['an unsubstituted variable', '$GIT_SHA'],
    ['something too short to be a sha', 'a2cf2'],
  ])('reports %s as unknown rather than as a commit', (_name, value) => {
    expect(shortSha(value)).toBe(UNKNOWN_GIT_SHA);
  });
});

describe('buildInfo', () => {
  it("reads the api's own version and rounds the uptime to whole seconds", () => {
    const info = buildInfo({ gitSha: 'a2cf2b3', nodeVersion: 'v24.18.0', uptimeSeconds: 12.7 });

    expect(info).toEqual({
      version: manifestVersion(),
      gitSha: 'a2cf2b3',
      nodeVersion: 'v24.18.0',
      uptimeSeconds: 13,
    });
  });

  it('falls back to this process when nothing is passed, so a dev tree still answers', () => {
    const info = buildInfo();

    expect(info.nodeVersion).toBe(process.version);
    // A sha or the word `unknown`, never a half-substituted build argument.
    expect(info.gitSha).toMatch(/^([0-9a-f]{7}|unknown)$/);
    expect(info.uptimeSeconds).toBe(Math.round(process.uptime()));
  });
});
