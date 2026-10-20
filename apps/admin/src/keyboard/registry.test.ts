import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPOSER_SHORTCUTS } from '../screens/tickets/composer.tsx';
import { TICKET_SHORTCUTS } from '../screens/tickets/ticket-shortcuts.js';
import { LIST_SHORTCUTS } from '../screens/tickets/tickets-page.tsx';
import { SHELL_SHORTCUTS } from '../shell/app-shell.tsx';
import { GLOBAL_SHORTCUTS } from './global-shortcuts.js';
import type { KeyStroke } from './keys.js';
import {
  groupOf,
  isSequence,
  SHORTCUT_GROUPS,
  SHORTCUT_LIST,
  type Shortcut,
  type ShortcutPermission,
} from './registry.js';

/**
 * The registry is the one place a shortcut is named (M14-01, ADR 0038). These
 * tests are what keep it so: every entry has a handler somewhere, every
 * handler has an entry, no two shortcuts that can answer at once share keys,
 * every entry has a name in both languages, and the guide's table is the
 * registry's.
 */

/** Every list of ids a screen attaches handlers for, with where it lives. */
const HANDLED = {
  'shell/app-shell.tsx': SHELL_SHORTCUTS,
  'keyboard/global-shortcuts.ts': GLOBAL_SHORTCUTS,
  'screens/tickets/tickets-page.tsx': LIST_SHORTCUTS,
  'screens/tickets/ticket-shortcuts.ts': TICKET_SHORTCUTS,
  'screens/tickets/composer.tsx': COMPOSER_SHORTCUTS,
} as const;

const handledIds = Object.values(HANDLED).flat();
const registeredIds = SHORTCUT_LIST.map((shortcut) => shortcut.id);

const repoFile = (...parts: string[]): string =>
  readFileSync(path.resolve(import.meta.dirname, '../../../..', ...parts), 'utf8');

describe('the shortcut registry', () => {
  it('has a handler for every entry', () => {
    expect(registeredIds.filter((id) => !handledIds.includes(id))).toEqual([]);
  });

  it('has an entry for every handler, and each handler in one place only', () => {
    expect(handledIds.filter((id) => !registeredIds.includes(id))).toEqual([]);
    expect(handledIds.filter((id, index) => handledIds.indexOf(id) !== index)).toEqual([]);
    expect(registeredIds.filter((id, index) => registeredIds.indexOf(id) !== index)).toEqual([]);
  });

  it('never gives two shortcuts that can answer at once the same keys', () => {
    const signature = (strokes: readonly KeyStroke[]): string =>
      strokes
        .map((stroke) => `${stroke.mod ? 'mod+' : ''}${stroke.shift ? 'shift+' : ''}${stroke.key}`)
        .join(' ');
    // The composer's answer only inside it, and every other scope can answer
    // together while a ticket is open.
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const shortcut of SHORTCUT_LIST) {
      for (const strokes of [shortcut.keys, ...(shortcut.alternates ?? [])]) {
        const key = `${shortcut.scope === 'composer' ? 'composer' : 'page'}:${signature(strokes)}`;
        const earlier = seen.get(key);
        if (earlier !== undefined) {
          clashes.push(`${earlier} and ${shortcut.id}`);
        }
        seen.set(key, shortcut.id);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('never makes the first key of a sequence a shortcut of its own', () => {
    const prefixes = new Set(
      SHORTCUT_LIST.filter(isSequence).map((shortcut) => shortcut.keys[0]?.key),
    );
    const shadowed = SHORTCUT_LIST.filter(
      (shortcut) =>
        !isSequence(shortcut) &&
        shortcut.keys[0]?.mod !== true &&
        prefixes.has(shortcut.keys[0]?.key),
    );
    expect(shadowed.map((shortcut) => shortcut.id)).toEqual([]);
  });

  it('names every entry and every group in English and Arabic', () => {
    for (const locale of ['en', 'ar']) {
      const catalog = JSON.parse(repoFile('packages/i18n/locales', locale, 'tickets.json')) as {
        keyboard: {
          groups: Record<string, string>;
          shortcut: Record<string, Record<string, string>>;
        };
      };
      const missing = [
        ...SHORTCUT_LIST.filter((shortcut) => {
          const [group, name] = shortcut.id.split('.');
          return !catalog.keyboard.shortcut[group ?? '']?.[name ?? ''];
        }).map((shortcut) => shortcut.id),
        ...SHORTCUT_GROUPS.filter((group) => !catalog.keyboard.groups[group]),
      ];
      expect({ locale, missing }).toEqual({ locale, missing: [] });
    }
  });
});

// ------------------------------------------------------------------ the guide

const WHO: Record<ShortcutPermission, string> = {
  'ticket:write': 'everyone but a Viewer',
  'report:read': 'everyone who is offered Reports',
  settings: 'everyone who is offered a page of the Admin group',
};

const GROUP_HEADINGS = {
  general: 'General',
  goTo: 'Go to',
  list: 'List',
  ticket: 'Ticket',
  composer: 'Composer',
} as const;

const strokeText = (stroke: KeyStroke): string =>
  [
    ...(stroke.mod ? ['`⌘`/`Ctrl`'] : []),
    ...(stroke.shift ? ['`Shift`'] : []),
    `\`${stroke.key}\``,
  ].join(' + ');

const keysText = (shortcut: Shortcut): string =>
  [shortcut.keys, ...(shortcut.alternates ?? [])]
    .map((strokes) => strokes.map(strokeText).join(' then '))
    .join(', or ');

/** The tables the guide carries between its markers, built from the registry. */
const expectedTables = (labels: Record<string, Record<string, string>>): string =>
  SHORTCUT_GROUPS.map((group) => {
    const rows = SHORTCUT_LIST.filter((shortcut) => groupOf(shortcut) === group).map((shortcut) => {
      const [scope, name] = shortcut.id.split('.');
      const label = labels[scope ?? '']?.[name ?? ''] ?? shortcut.id;
      const who = shortcut.permission === undefined ? 'everyone' : WHO[shortcut.permission];
      return `| ${keysText(shortcut)} | ${label} | ${who} |`;
    });
    return [
      `### ${GROUP_HEADINGS[group]}`,
      '',
      '| Keys | Does | For |',
      '|---|---|---|',
      ...rows,
    ].join('\n');
  }).join('\n\n');

describe('docs/guides/keyboard-shortcuts.md', () => {
  it('carries the registry’s tables, so the guide cannot drift from the keys', () => {
    const guide = repoFile('docs/guides/keyboard-shortcuts.md');
    const start = '<!-- shortcuts:start -->';
    const end = '<!-- shortcuts:end -->';
    const between = guide.slice(guide.indexOf(start) + start.length, guide.indexOf(end)).trim();
    const catalog = JSON.parse(repoFile('packages/i18n/locales/en/tickets.json')) as {
      keyboard: { shortcut: Record<string, Record<string, string>> };
    };

    // When this fails, paste the expected text between the markers.
    expect(between).toBe(expectedTables(catalog.keyboard.shortcut));
  });
});
