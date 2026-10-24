#!/usr/bin/env node
// Stamps a release version into the website. The pages carry a real version so
// a local preview and the no-JS page are correct; `<meta name="helpdock-release">`
// marks which one. See docs/guides/website.md.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const META = /(<meta\s+name="helpdock-release"\s+content=")([^"]*)(")/;

/**
 * @param {string} html
 * @param {string} version strict x.y.z
 * @returns {{ html: string, from: string }}
 */
export function stampHtml(html, version) {
  if (!SEMVER.test(version)) {
    throw new Error(`"${version}" is not a plain x.y.z version`);
  }
  const meta = META.exec(html);
  if (!meta) throw new Error('no <meta name="helpdock-release"> found');
  const from = meta[2];
  if (!SEMVER.test(from)) throw new Error(`the page carries "${from}", which is not x.y.z`);
  if (from === version) return { html, from };
  // `1.0.10`, `11.0.1`, `1.0.1.2` and `1.0.1-rc.1` are other versions, so they
  // are never touched. A leading hyphen is fine: `helpdock-1.0.1.cdx.json`.
  const old = new RegExp(
    `(?<![\\d.])${from.replaceAll('.', '\\.')}(?!\\d|\\.\\d|-[0-9A-Za-z])`,
    'g',
  );
  return { html: html.replace(old, version), from };
}

/** @param {string} dir */
export function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return htmlFiles(path);
    return name.endsWith('.html') ? [path] : [];
  });
}

/**
 * @param {string} dir the site folder
 * @param {string} version
 * @returns {string[]} the files that changed
 */
export function stampSite(dir, version) {
  const changed = [];
  let found = 0;
  for (const file of htmlFiles(dir)) {
    const html = readFileSync(file, 'utf8');
    if (!META.test(html)) continue;
    found += 1;
    const next = stampHtml(html, version);
    if (next.html !== html) {
      writeFileSync(file, next.html);
      changed.push(file);
    }
  }
  if (found === 0) throw new Error(`no page under ${dir} carries a helpdock-release meta`);
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const version = process.argv[2] ?? '';
    const dir = process.argv[3] ?? 'site';
    const changed = stampSite(dir, version);
    console.log(
      changed.length ? `Stamped ${version} into ${changed.join(', ')}` : `Already ${version}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
