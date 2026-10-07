/**
 * Pure helpers for `render-artboards.ts`: reading the design canvas manifest,
 * deciding where each rendered artboard lands and turning a `.dc.html` source
 * into a static page a browser can screenshot.
 */

export interface Board {
  readonly title: string;
  readonly w: number;
  readonly h: number;
  readonly x: number;
  readonly y: number;
}

interface Note {
  readonly kind?: string;
  readonly y: number;
}

export interface Canvas {
  readonly boards: Readonly<Record<string, Board>>;
  readonly notes?: Readonly<Record<string, Note>>;
  readonly order?: readonly string[];
}

export interface Section {
  readonly group: string;
  readonly y: number;
}

/**
 * Canvas section titles (`kind: "title1"` notes) are keyed `m0`, `m1b`, `m7b`
 * and so on; a trailing letter only splits a milestone across rows, so the
 * group drops it.
 */
export function sectionsOf(canvas: Canvas): Section[] {
  return Object.entries(canvas.notes ?? {})
    .filter(([, note]) => note.kind === 'title1')
    .map(([key, note]) => ({ group: key.replace(/^(m\d+)[a-z]$/, '$1'), y: note.y }))
    .sort((a, b) => a.y - b.y);
}

/** A board belongs to the last section title above it on the canvas. */
export function groupOf(board: Board, sections: readonly Section[]): string {
  let group = 'ungrouped';
  for (const section of sections) {
    if (section.y <= board.y) group = section.group;
  }
  return group;
}

/** `Admin/Ticket-SLA` becomes `Admin-Ticket-SLA`; `Widget · AR (RTL)` becomes `Widget-AR-RTL`. */
export function fileNameOf(title: string): string {
  return title
    .replace(/[\s/·]+/g, '-')
    .replace(/[^A-Za-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const SUPPORT_SCRIPT = /<script\s+src="\.\/support\.js"\s*><\/script>\s*/g;
const GOOGLE_FONTS = /<link\b[^>]*\bhref="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*>\s*/g;
const DC_SCRIPT = /<script\b[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/;
const DATA_PROPS = /\bdata-props='([^']*)'/;

/**
 * Removes every match, then what removing them exposed (`<scr<script>ipt>`
 * becomes `<script>`), until a pass changes nothing.
 */
const removeEvery = (text: string, pattern: RegExp): string => {
  let current = text;
  for (;;) {
    const next = current.replace(pattern, '');
    if (next === current) {
      return current;
    }
    current = next;
  }
};

export interface DcSource {
  /** The page without the canvas runtime, the logic script and the Google Fonts links. */
  readonly html: string;
  /** Body of the `Component` class script, evaluated in the browser for its hole values. */
  readonly logic: string;
  /** `default` of every editable prop, such as the brand `accent`. */
  readonly defaults: Readonly<Record<string, unknown>>;
}

export function parseDcSource(source: string): DcSource {
  const script = DC_SCRIPT.exec(source);
  const propsJson = script ? DATA_PROPS.exec(script[0])?.[1] : undefined;
  const props: Record<string, unknown> = propsJson ? JSON.parse(propsJson) : {};
  const defaults: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(props)) {
    if (name !== '$preview' && typeof spec === 'object' && spec !== null && 'default' in spec) {
      defaults[name] = spec.default;
    }
  }
  return {
    html: [SUPPORT_SCRIPT, GOOGLE_FONTS, DC_SCRIPT].reduce(removeEvery, source),
    logic: script?.[1] ?? '',
    defaults,
  };
}

const HOLE = /\{\{\s*([\w$.]+)\s*\}\}/g;
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function lookup(values: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = values;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Single pass, so a value that itself shows a placeholder (a macro body with
 * `{{ticket.number}}`) is rendered literally, as the canvas shows it. Holes
 * with no scalar value are left untouched for the same reason.
 */
export function fillHoles(html: string, values: Readonly<Record<string, unknown>>): string {
  return html.replace(HOLE, (hole, path: string) => {
    const value = lookup(values, path);
    if (value === undefined || value === null || typeof value === 'object') return hole;
    return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
  });
}

/**
 * Inlines the `url('./file.woff2')` sources of a stylesheet as data URIs, so a
 * page set from a string can use them without a server.
 */
export function inlineFontUrls(css: string, readFont: (file: string) => Buffer): string {
  return css.replace(
    /url\('\.\/([^']+\.woff2)'\)/g,
    (_, file: string) => `url('data:font/woff2;base64,${readFont(file).toString('base64')}')`,
  );
}

/** Puts a stylesheet first in `<head>`, ahead of the artboard's own styles. */
export function withStylesheet(html: string, css: string): string {
  return html.replace(/<head>/i, () => `<head>\n<style>${css}</style>`);
}
