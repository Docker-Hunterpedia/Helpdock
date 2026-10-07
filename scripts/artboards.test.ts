import { describe, expect, it } from 'vitest';
import {
  type Board,
  type Canvas,
  fileNameOf,
  fillHoles,
  groupOf,
  inlineFontUrls,
  parseDcSource,
  sectionsOf,
  withStylesheet,
} from './artboards.ts';

function board(y: number): Board {
  return { title: 'Admin/Login', w: 1280, h: 800, x: 0, y };
}

describe('sectionsOf and groupOf', () => {
  const canvas: Canvas = {
    boards: {},
    notes: {
      m1b: { kind: 'title1', y: 8940 },
      foundations: { kind: 'title1', y: -260 },
      'm0-note': { y: 2660 },
      m0: { kind: 'title1', y: 2400 },
      m1: { kind: 'title1', y: 5620 },
    },
  };
  const sections = sectionsOf(canvas);

  it('keeps only section titles, ordered top to bottom, folding row suffixes into the milestone', () => {
    expect(sections.map((section) => section.group)).toEqual(['foundations', 'm0', 'm1', 'm1']);
  });

  it('puts a board under the last section title above it', () => {
    expect(groupOf(board(0), sections)).toBe('foundations');
    expect(groupOf(board(2660), sections)).toBe('m0');
    expect(groupOf(board(10220), sections)).toBe('m1');
  });

  it('reports a board above every section as ungrouped', () => {
    expect(groupOf(board(-1000), sections)).toBe('ungrouped');
  });
});

describe('fileNameOf', () => {
  it.each([
    ['Admin/Ticket-SLA', 'Admin-Ticket-SLA'],
    ['Widget · AR (RTL)', 'Widget-AR-RTL'],
    ['Admin/System-1.0', 'Admin-System-1.0'],
    ['01 Color', '01-Color'],
  ])('turns %s into %s', (title, expected) => {
    expect(fileNameOf(title)).toBe(expected);
  });
});

describe('parseDcSource', () => {
  const source = [
    '<html><head><script src="./support.js"></script></head><body><x-dc><helmet>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans&display=swap">',
    '</helmet><div style="color: {{accent}}">Hi</div></x-dc>',
    `<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#0F766E"},"$preview":{"width":440,"height":760}}'>`,
    'class Component extends DCLogic { renderVals() { return {}; } }',
    '</script></body></html>',
  ].join('\n');
  const dc = parseDcSource(source);

  it('removes the canvas runtime, the logic script and the Google Fonts link', () => {
    expect(dc.html).not.toContain('support.js');
    expect(dc.html).not.toContain('data-dc-script');
    expect(dc.html).not.toContain('fonts.googleapis.com');
    expect(dc.html).toContain('<div style="color: {{accent}}">Hi</div>');
  });

  it('returns the logic source and the prop defaults without the preview size', () => {
    expect(dc.logic).toContain('class Component extends DCLogic');
    expect(dc.defaults).toEqual({ accent: '#0F766E' });
  });

  it('removes a script that removing another one exposes', () => {
    const runtime = '<script src="./support.js"></script>';
    const nested = `<div>${runtime.slice(0, 4)}${runtime}${runtime.slice(4)}</div>`;

    expect(parseDcSource(nested).html).toBe('<div></div>');
  });

  it('handles a page with no logic script', () => {
    expect(parseDcSource('<div>static</div>')).toEqual({
      html: '<div>static</div>',
      logic: '',
      defaults: {},
    });
  });
});

describe('fillHoles', () => {
  it('fills top-level and dotted holes, escaping HTML', () => {
    const html = '<p style="color: {{accent}}">{{ ph.first }} {{body}}</p>';
    const values = { accent: '#0F766E', ph: { first: 'Mona' }, body: '<b>"hi"</b>' };

    expect(fillHoles(html, values)).toBe(
      '<p style="color: #0F766E">Mona &lt;b&gt;&quot;hi&quot;&lt;/b&gt;</p>',
    );
  });

  it('leaves holes without a scalar value, and placeholders inside values, as written', () => {
    const html = '{{contact.first_name}} {{ph}} {{tpl}}';
    const values = { ph: { first: 'x' }, tpl: 'Hi {{contact.first_name}}' };

    expect(fillHoles(html, values)).toBe('{{contact.first_name}} {{ph}} Hi {{contact.first_name}}');
  });
});

describe('inlineFontUrls and withStylesheet', () => {
  it('replaces relative woff2 sources with data URIs', () => {
    const css = "src: url('./plex-400.woff2') format('woff2');";
    const inlined = inlineFontUrls(css, (file) => Buffer.from(file));

    expect(inlined).toBe(
      `src: url('data:font/woff2;base64,${Buffer.from('plex-400.woff2').toString('base64')}') format('woff2');`,
    );
  });

  it('inserts the stylesheet at the start of the head', () => {
    expect(withStylesheet('<head><title>x</title></head>', 'a{}')).toBe(
      '<head>\n<style>a{}</style><title>x</title></head>',
    );
  });
});
