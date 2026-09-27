import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cacheControlFor, isApiPath, resolveAdminDist, resolveAssetPath } from './admin-assets.js';

// Pass-through spies, so a test can prove a path never reached the file system.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync), realpathSync: vi.fn(actual.realpathSync) };
});

const root = mkdtempSync(path.join(tmpdir(), 'helpdock-assets-'));
mkdirSync(path.join(root, 'assets'));
writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
writeFileSync(path.join(root, 'assets', 'index-Abc12345.js'), 'export {};');
writeFileSync(path.join(root, 'favicon.svg'), '<svg />');

const outside = mkdtempSync(path.join(tmpdir(), 'helpdock-outside-'));
writeFileSync(path.join(outside, 'secret.txt'), 'not for you');

describe('resolveAdminDist', () => {
  it('accepts a directory that holds an index.html', () => {
    expect(resolveAdminDist(root)).toBe(path.resolve(root));
  });

  it('returns undefined for a directory with no build in it', () => {
    // A checkout that has not run `pnpm build`, and the dev loop where Vite
    // serves the SPA instead. The api still has to boot.
    expect(resolveAdminDist(outside)).toBeUndefined();
    expect(resolveAdminDist(path.join(root, 'nothing-here'))).toBeUndefined();
  });
});

describe('isApiPath', () => {
  it.each(['/api', '/api/', '/api/me', '/api/brands/1'])('claims %s for the api', (pathname) => {
    expect(isApiPath(pathname)).toBe(true);
  });

  it.each(['/', '/apiary', '/tickets/42', '/assets/index-Abc12345.js'])(
    'leaves %s to the SPA',
    (pathname) => {
      expect(isApiPath(pathname)).toBe(false);
    },
  );
});

describe('resolveAssetPath', () => {
  it('finds a file in the build', () => {
    expect(resolveAssetPath(root, '/assets/index-Abc12345.js')).toBe(
      path.join('assets', 'index-Abc12345.js'),
    );
    expect(resolveAssetPath(root, '/favicon.svg')).toBe('favicon.svg');
  });

  it('decodes an escaped path', () => {
    expect(resolveAssetPath(root, '/assets/index-Abc12345%2Ejs')).toBe(
      path.join('assets', 'index-Abc12345.js'),
    );
  });

  it.each([
    ['/', 'the root, which is the SPA entry'],
    ['/tickets/42', 'a client-side route'],
    ['/assets', 'a directory rather than a file'],
    ['/assets/%E0%A4%A', 'a malformed escape'],
    ['/favicon.svg%00.txt', 'an embedded NUL'],
  ])('returns undefined for %s (%s)', (pathname) => {
    expect(resolveAssetPath(root, pathname)).toBeUndefined();
  });

  it.each(['/../secret.txt', '/assets/../../secret.txt', '/..%2f..%2fsecret.txt', '//etc/passwd'])(
    'refuses %s rather than reading outside the build',
    (pathname) => {
      expect(resolveAssetPath(root, pathname)).toBeUndefined();
    },
  );

  const fsCalls = (): string[] =>
    [...vi.mocked(statSync).mock.calls, ...vi.mocked(realpathSync).mock.calls].map(([target]) =>
      String(target),
    );

  it.each([
    '/../../etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%5c..%5cetc%5cpasswd',
  ])('refuses %s without the file system seeing a path outside the build', (pathname) => {
    vi.mocked(statSync).mockClear();
    vi.mocked(realpathSync).mockClear();

    expect(resolveAssetPath(root, pathname)).toBeUndefined();
    for (const target of fsCalls()) {
      expect(target === root || target.startsWith(root + path.sep)).toBe(true);
    }
  });

  it.each(['../secret.txt', '..%2f..%2fetc%2fpasswd', 'assets/../../secret.txt'])(
    'refuses the relative traversal %s before any file system call',
    (pathname) => {
      vi.mocked(statSync).mockClear();
      vi.mocked(realpathSync).mockClear();

      expect(resolveAssetPath(root, pathname)).toBeUndefined();
      expect(fsCalls()).toEqual([]);
    },
  );

  it('refuses a symbolic link that resolves out of the build', () => {
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt'));

    expect(resolveAssetPath(root, '/linked.txt')).toBeUndefined();
  });
});

describe('cacheControlFor', () => {
  it('never caches index.html, because it names the hashed bundles', () => {
    expect(cacheControlFor('index.html')).toBe('no-store');
  });

  it('keeps a content-hashed asset for a year', () => {
    expect(cacheControlFor(path.join('assets', 'index-Abc12345.js'))).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('gives everything else an hour', () => {
    expect(cacheControlFor('favicon.svg')).toBe('public, max-age=3600');
    expect(cacheControlFor(path.join('images', 'logo.png'))).toBe('public, max-age=3600');
  });
});
