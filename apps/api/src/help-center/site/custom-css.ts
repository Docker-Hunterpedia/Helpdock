import {
  HC_MEDIA_PATH_PATTERN,
  type HcCssRemoval,
  type HcCssRemovalReason,
} from '@helpdock/schemas';

/**
 * A brand's custom CSS (M5-06, DESIGN §8), made safe to put in a `<style>` on
 * the help center: no `@import`, no `url()` except an inline image or one of
 * this brand's own uploads, no `expression()` or binding, no fixed overlays.
 *
 * ADR 0007's sanitiser is an HTML library and has no stylesheet parser, so
 * this is a small **allowlist parser** of its own: it reads the text into
 * style rules and `@media` blocks, keeps each declaration only when it passes
 * every check, and writes back only what it kept. Anything it does not
 * understand is dropped rather than passed through, and every drop is
 * reported, so the admin can say what went and why.
 *
 * Two rules keep the output inert whatever the input was: a backslash is never
 * kept (CSS escapes are how `url` is spelled `u\72l` to slip past a check),
 * and neither is `<` (so no value can close the `<style>` it is rendered in).
 */

export interface SanitizedCss {
  /** Safe to render inside the page's nonce'd `<style>`. */
  readonly css: string;
  readonly removed: readonly HcCssRemoval[];
}

/** Longest excerpt of a dropped rule the admin is shown. */
const EXCERPT_MAX = 200;

const PROPERTY = /^(?:--[a-zA-Z0-9_-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/;
const MEDIA_PRELUDE = /^[a-zA-Z0-9\s(),:.\-/]+$/;
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;
/** Properties that run code in some engine, whatever their value. */
const BINDINGS = new Set(['behavior', '-moz-binding']);

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX - 1)}…` : flat;
};

/** Removes comments outside strings. An unterminated one swallows the rest, as a browser would. */
const stripComments = (input: string): string => {
  let out = '';
  let quote: string | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] ?? '';
    if (quote !== null) {
      out += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2);
      if (end === -1) {
        break;
      }
      index = end + 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
};

/**
 * The index of the first `stop` character at depth zero from `start`, outside
 * strings and brackets, or -1. `{` opens a depth too, so a nested block is
 * skipped over as one unit.
 */
const scanTo = (text: string, start: number, stops: string): number => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (depth === 0 && stops.includes(char)) {
      return index;
    } else if (char === '(' || char === '{' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
    }
  }
  return -1;
};

/** Splits on `separator` at depth zero, outside strings. */
const splitTop = (text: string, separator: string): string[] => {
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    const at = scanTo(text, start, separator);
    if (at === -1) {
      parts.push(text.slice(start));
      return parts;
    }
    parts.push(text.slice(start, at));
    start = at + 1;
  }
};

/** Why a value may not be kept, or null when it may. */
const valueProblem = (
  property: string,
  value: string,
  brandId: string,
): HcCssRemovalReason | null => {
  const lower = value.toLowerCase();
  if (BINDINGS.has(property.toLowerCase()) || /expression\s*\(|javascript:/.test(lower)) {
    return 'expression';
  }
  if (/(?:image-set|\bsrc)\s*\(/.test(lower)) {
    return 'url';
  }
  for (const match of lower.matchAll(/url\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length;
    const close = value.indexOf(')', open);
    const target = (close === -1 ? '' : value.slice(open, close))
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    const ownUpload =
      HC_MEDIA_PATH_PATTERN.test(target) &&
      target.startsWith(`/api/help-center/brands/${brandId}/`);
    if (!ownUpload && !INLINE_IMAGE.test(target)) {
      return 'url';
    }
  }
  if (property.toLowerCase() === 'position' && /\bfixed\b/.test(lower)) {
    return 'fixed';
  }
  return null;
};

interface Collected {
  readonly kept: string[];
  readonly removed: HcCssRemoval[];
}

const keepDeclarations = (
  selector: string,
  block: string,
  brandId: string,
  removed: HcCssRemoval[],
): string[] => {
  const kept: string[] = [];
  for (const raw of splitTop(block, ';')) {
    const declaration = raw.trim();
    if (declaration === '') {
      continue;
    }
    const drop = (reason: HcCssRemovalReason): void => {
      removed.push({ rule: excerpt(`${selector} { ${declaration}; }`), reason });
    };
    const colon = declaration.indexOf(':');
    const property = colon === -1 ? '' : declaration.slice(0, colon).trim();
    const value = colon === -1 ? '' : declaration.slice(colon + 1).trim();
    if (declaration.includes('\\')) {
      drop('escape');
    } else if (!PROPERTY.test(property) || value === '' || /[<{}]/.test(value)) {
      drop('malformed');
    } else {
      const problem = valueProblem(property, value, brandId);
      if (problem === null) {
        kept.push(`${property}: ${value}`);
      } else {
        drop(problem);
      }
    }
  }
  return kept;
};

/**
 * Reads rules until the end of `text`. Inside `@media` (`nested`), a further
 * at-rule is dropped: one level is what a help center theme needs.
 */
const collectRules = (text: string, brandId: string, nested: boolean, out: Collected): void => {
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index += 1;
    }
    if (index >= text.length) {
      return;
    }

    const open = scanTo(text, index, '{;}');
    if (open === -1 || text[open] !== '{') {
      const end = open === -1 ? text.length : open + 1;
      const stray = text.slice(index, end).trim();
      const isImport = /^@import\b/i.test(stray);
      if (stray !== '' && stray !== '}') {
        out.removed.push({
          rule: excerpt(stray),
          reason: isImport ? 'import' : stray.startsWith('@') ? 'at-rule' : 'malformed',
        });
      }
      index = end;
      continue;
    }

    const close = scanTo(text, open + 1, '}');
    const end = close === -1 ? text.length : close;
    const prelude = text.slice(index, open).trim();
    const body = text.slice(open + 1, end);
    index = end + 1;

    if (prelude.startsWith('@')) {
      const media = /^@media\s+(.+)$/is.exec(prelude);
      if (nested || media === null) {
        out.removed.push({
          rule: excerpt(`${prelude} { … }`),
          reason: /^@import\b/i.test(prelude) ? 'import' : 'at-rule',
        });
        continue;
      }
      const query = (media[1] ?? '').trim();
      if (!MEDIA_PRELUDE.test(query)) {
        out.removed.push({
          rule: excerpt(`${prelude} { … }`),
          reason: query.includes('\\') ? 'escape' : 'malformed',
        });
        continue;
      }
      const inner: Collected = { kept: [], removed: out.removed };
      collectRules(body, brandId, true, inner);
      if (inner.kept.length > 0) {
        out.kept.push(`@media ${query} {\n${inner.kept.map((rule) => `  ${rule}`).join('\n')}\n}`);
      }
      continue;
    }

    if (prelude.includes('\\')) {
      out.removed.push({ rule: excerpt(`${prelude} { ${body.trim()} }`), reason: 'escape' });
      continue;
    }
    if (prelude === '' || /[<{};@]/.test(prelude) || scanTo(body, 0, '{') !== -1) {
      out.removed.push({ rule: excerpt(`${prelude} { ${body.trim()} }`), reason: 'malformed' });
      continue;
    }
    const declarations = keepDeclarations(prelude, body, brandId, out.removed);
    if (declarations.length > 0) {
      out.kept.push(`${prelude} { ${declarations.join('; ')}; }`);
    }
  }
};

export const sanitizeCustomCss = (
  input: string,
  { brandId }: { brandId: string },
): SanitizedCss => {
  const out: Collected = { kept: [], removed: [] };
  collectRules(stripComments(input), brandId, false, out);
  return { css: out.kept.join('\n'), removed: out.removed };
};
