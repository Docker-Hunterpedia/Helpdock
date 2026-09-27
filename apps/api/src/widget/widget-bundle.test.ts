import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveWidgetDist,
  widgetAssetPath,
  widgetFileHeaders,
  widgetFileParamSchema,
} from './widget-bundle.js';

let parent = '';
let root = '';

beforeAll(async () => {
  parent = await mkdtemp(path.join(tmpdir(), 'helpdock-widget-dist-'));
  root = path.join(parent, 'dist');
  await mkdir(path.join(root, 'chunks'), { recursive: true });
  await mkdir(path.join(root, 'widget-fonts'));
  await writeFile(path.join(root, 'widget.js'), 'export {};');
  await writeFile(path.join(root, 'chunks', 'remote-abc.js'), 'export {};');
  await writeFile(path.join(root, 'widget-fonts', 'plex.woff2'), 'woff2');
  await writeFile(path.join(parent, 'outside.js'), 'secret');
  await symlink(path.join(parent, 'outside.js'), path.join(root, 'chunks', 'escape.js'));
});

afterAll(async () => {
  await rm(parent, { recursive: true, force: true });
});

describe('resolveWidgetDist', () => {
  it('finds a build by its widget.js, and nothing where there is none', async () => {
    expect(resolveWidgetDist(root)).toBe(root);
    expect(resolveWidgetDist(path.join(root, 'chunks'))).toBeUndefined();
  });
});

describe('widgetAssetPath', () => {
  it('maps the entry, a chunk and a font to files of the build', () => {
    expect(widgetAssetPath(root, null, 'widget.js')).toBe('widget.js');
    expect(widgetAssetPath(root, 'chunks', 'remote-abc.js')).toBe(
      path.join('chunks', 'remote-abc.js'),
    );
    expect(widgetAssetPath(root, 'widget-fonts', 'plex.woff2')).toBe(
      path.join('widget-fonts', 'plex.woff2'),
    );
  });

  it('answers nothing for a missing file or a link out of the build', () => {
    expect(widgetAssetPath(root, 'chunks', 'missing.js')).toBeUndefined();
    expect(widgetAssetPath(root, 'chunks', 'escape.js')).toBeUndefined();
  });
});

describe('widgetFileParamSchema', () => {
  it('takes a file name and nothing that could climb out of its folder', () => {
    expect(widgetFileParamSchema.safeParse({ file: 'remote-Cnr2-TYR.js' }).success).toBe(true);
    expect(widgetFileParamSchema.safeParse({ file: '..' }).success).toBe(false);
    expect(widgetFileParamSchema.safeParse({ file: '../widget.js' }).success).toBe(false);
    expect(widgetFileParamSchema.safeParse({ file: '.env' }).success).toBe(false);
  });
});

describe('widgetFileHeaders', () => {
  it('lets any site load the files, and keeps the hashed chunks for a year', () => {
    expect(widgetFileHeaders(path.join('chunks', 'remote-abc.js'))).toEqual({
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': 'text/javascript; charset=utf-8',
    });
  });

  it('revalidates widget.js within minutes, since its name survives a deploy', () => {
    expect(widgetFileHeaders('widget.js')['cache-control']).toBe('public, max-age=300');
  });

  it('types a font and a source map, and anything else as bytes', () => {
    expect(widgetFileHeaders(path.join('widget-fonts', 'a.woff2'))).toMatchObject({
      'content-type': 'font/woff2',
      'cache-control': 'public, max-age=604800',
    });
    expect(widgetFileHeaders(path.join('chunks', 'a.js.map'))['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(widgetFileHeaders('README')['content-type']).toBe('application/octet-stream');
  });
});
