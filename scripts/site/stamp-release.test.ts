import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without declarations
import { stampHtml, stampSite } from './stamp-release.mjs';

const page = (version: string) => `<meta name="helpdock-release" content="${version}">
"softwareVersion": "${version}",
<a href="https://github.com/Docker-Hunterpedia/Helpdock/releases/tag/v${version}">Helpdock ${version}</a>
<bdi>${version}</bdi> aria-label="The ${version} release image"
ghcr.io/docker-hunterpedia/helpdock:${version} helpdock-${version}.cdx.json
HELPDOCK_VERSION=${version} --branch v${version}
`;

describe('stampHtml', () => {
  it('rewrites every form of the version and the meta', () => {
    const { html, from } = stampHtml(page('1.0.1'), '1.2.0');
    expect(from).toBe('1.0.1');
    expect(html).toBe(page('1.2.0'));
    expect(html).not.toContain('1.0.1');
  });

  it('leaves other versions that contain the digits alone', () => {
    const extra = '1.0.10 11.0.1 1.0.1.2 v1.0.12 1.0.0 1.0.1-rc.1 x1.0.1';
    const { html } = stampHtml(`${page('1.0.1')}${extra}\n`, '2.0.0');
    expect(html.endsWith(`${extra.replace('x1.0.1', 'x2.0.0')}\n`)).toBe(true);
  });

  it('does not treat dots as wildcards', () => {
    const { html } = stampHtml(`${page('1.0.1')}1x0x1\n`, '1.0.2');
    expect(html).toContain('1x0x1');
  });

  it('is idempotent', () => {
    const once = stampHtml(page('1.0.1'), '1.3.0').html;
    expect(stampHtml(once, '1.3.0').html).toBe(once);
  });

  it('rejects a missing meta', () => {
    expect(() => stampHtml('<p>1.0.1</p>', '1.0.2')).toThrow(/helpdock-release/);
  });

  it.each(['v1.0.2', '1.0', '1.0.2-rc.1', '', '01.0.2', '1.0.2\n'])(
    'rejects the version "%s"',
    (v) => {
      expect(() => stampHtml(page('1.0.1'), v)).toThrow(/not a plain/);
    },
  );
});

describe('stampSite', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'ar'));
    writeFileSync(join(dir, 'index.html'), page('1.0.1'));
    writeFileSync(join(dir, 'ar', 'index.html'), `<bdi>1.0.1</bdi>\n${page('1.0.1')}`);
    writeFileSync(join(dir, '404.html'), '<p>1.0.1 stays: no meta</p>');
    return dir;
  };

  it('stamps pages that carry the meta and skips the others', () => {
    const dir = make();
    expect(stampSite(dir, '1.1.0')).toHaveLength(2);
    expect(readFileSync(join(dir, 'ar', 'index.html'), 'utf8')).toBe(
      `<bdi>1.1.0</bdi>\n${page('1.1.0')}`,
    );
    expect(readFileSync(join(dir, '404.html'), 'utf8')).toContain('1.0.1');
    expect(stampSite(dir, '1.1.0')).toEqual([]);
  });

  it('fails when no page carries the meta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<p>nothing</p>');
    expect(() => stampSite(dir, '1.1.0')).toThrow(/no page/);
  });

  it('stamps the real site and is a no-op at its current version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
    dirs.push(dir);
    cpSync(join(import.meta.dirname, '../../site'), dir, { recursive: true });
    const current = /name="helpdock-release" content="([^"]+)"/.exec(
      readFileSync(join(dir, 'index.html'), 'utf8'),
    )?.[1];
    expect(current).toBeDefined();
    expect(stampSite(dir, current as string)).toEqual([]);
    expect(stampSite(dir, '9.8.7').length).toBe(2);
    const en = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(en).toContain('helpdock:9.8.7');
    expect(en).not.toContain(`${current}`);
  });
});
