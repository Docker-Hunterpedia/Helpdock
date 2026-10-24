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
 * The registry is the one place a shortcut is named (M14-01, ADR 0038). What
 * these tests guarantee, and what they do not:
 *
 * - Every key-press entry is in exactly one screen's list of handled ids, and
 *   every listed id is an entry. `useShortcutHandlers` is typed to take a
 *   handler for exactly the ids of the list it is given, so a listed id cannot
 *   be left without a handler in the code.
 * - Each list is attached: the source of the screen that owns it calls
 *   `useShortcutHandlers` with that list (and the shell mounts the global and
 *   ticket hooks). This is a source check, not a render; whether a handler is
 *   attached *right now* (a ticket open, a writer signed in) is the screens'
 *   own tests' business (`keyboard.test.tsx`).
 * - A `typed` entry (`composer.savedReply`, `/` typed into an empty reply) has
 *   no key handler: the dispatcher never runs it. It is held instead to the
 *   composer reading its key from the registry.
 * - No two shortcuts that can answer at once share keys, every entry is named
 *   in both languages, and the guide's tables are the registry's.
 */

/** Every list of ids a screen attaches handlers for, by the file that attaches it. */
const HANDLED = {
  'apps/admin/src/shell/app-shell.tsx': ['SHELL_SHORTCUTS', SHELL_SHORTCUTS],
  'apps/admin/src/keyboard/global-shortcuts.ts': ['GLOBAL_SHORTCUTS', GLOBAL_SHORTCUTS],
  'apps/admin/src/screens/tickets/tickets-page.tsx': ['LIST_SHORTCUTS', LIST_SHORTCUTS],
  'apps/admin/src/screens/tickets/ticket-shortcuts.ts': ['TICKET_SHORTCUTS', TICKET_SHORTCUTS],
  'apps/admin/src/screens/tickets/composer.tsx': ['COMPOSER_SHORTCUTS', COMPOSER_SHORTCUTS],
} as const;

/** The hooks above that are not components themselves, and the screen that mounts each. */
const MOUNTED_BY = {
  'apps/admin/src/shell/app-shell.tsx': 'useGlobalShortcuts()',
  'apps/admin/src/screens/tickets/ticket-view.tsx': 'useTicketShortcuts(',
} as const;

const handledIds: readonly string[] = Object.values(HANDLED).flatMap(([, ids]) => ids);
const pressedIds: readonly string[] = SHORTCUT_LIST.filter(
  (shortcut) => shortcut.typed !== true,
).map((shortcut) => shortcut.id);
const registeredIds = SHORTCUT_LIST.map((shortcut) => shortcut.id);

const repoFile = (...parts: string[]): string =>
  readFileSync(path.resolve(import.meta.dirname, '../../../..', ...parts), 'utf8');

describe('the shortcut registry', () => {
  it('has a handler list for every key-press entry, and an entry for every listed id', () => {
    expect(pressedIds.filter((id) => !handledIds.includes(id))).toEqual([]);
    expect(handledIds.filter((id) => !pressedIds.includes(id))).toEqual([]);
    expect(handledIds.filter((id, index) => handledIds.indexOf(id) !== index)).toEqual([]);
    expect(registeredIds.filter((id, index) => registeredIds.indexOf(id) !== index)).toEqual([]);
  });

  it('attaches every list where it is declared, and mounts the hooks that attach them', () => {
    const unattached = Object.entries(HANDLED)
      .filter(
        ([file, [name]]) =>
          !repoFile(file).includes(`useShortcutHandlers<(typeof ${name})[number]>(`),
      )
      .map(([file]) => file);
    const unmounted = Object.entries(MOUNTED_BY)
      .filter(([file, call]) => !repoFile(file).includes(call))
      .map(([file]) => file);

    expect({ unattached, unmounted }).toEqual({ unattached: [], unmounted: [] });
  });

  it('reads the typed saved-reply trigger from the registry in the composer', () => {
    expect(SHORTCUT_LIST.filter((shortcut) => shortcut.typed === true).map((s) => s.id)).toEqual([
      'composer.savedReply',
    ]);
    expect(repoFile('apps/admin/src/screens/tickets/composer.tsx')).toContain(
      "shortcutById('composer.savedReply')",
    );
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
  settings: 'everyone (opens the first page of Settings they have)',
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
