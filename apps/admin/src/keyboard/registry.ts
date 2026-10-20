import type { KeyStroke } from './keys.js';

/**
 * Every keyboard shortcut in the admin, named once (M14-01, ADR 0038).
 *
 * The `?` sheet, each button's `aria-keyshortcuts` and the guide's table are
 * read from this list, so none of them can drift from what the keys do. A
 * handler is attached by id where the action lives (`useShortcutHandlers`),
 * and `registry.test.ts` fails when an entry has no handler or a handler has
 * no entry.
 *
 * Scopes say where a shortcut answers. `global` is anywhere in the signed-in
 * admin; `list` and `ticket` while the ticket workspace, or an open ticket,
 * is on screen; `composer` only while the caret is in the composer, which is
 * why every composer shortcut but `/` carries a modifier. A sequence (`g`
 * then a letter) is a global shortcut, drawn in the sheet's "Go to" group.
 *
 * Not here yet, because what they act on does not exist: `⌘K` the command
 * palette (M14-05), `x` and `Shift`+`x` selection and `Esc` to clear it
 * (M14-04), `h` snooze (M14-02), `{{` the placeholder picker (M14-14) and
 * `Enter` on a focused row, which needs the focus model of M14-04.
 */

export type ShortcutScope = 'global' | 'list' | 'ticket' | 'composer';

/** What the sheet groups by: the scopes, with the sequences apart. */
export type ShortcutGroup = 'general' | 'goTo' | 'list' | 'ticket' | 'composer';

/**
 * What a person must be able to do for the shortcut to be offered. The sheet
 * leaves out what they cannot use; the api refuses it whatever the keys do.
 * `settings` is "is offered an entry of the sidebar's Admin group".
 */
export type ShortcutPermission = 'ticket:write' | 'report:read' | 'settings';

const KEY = (key: string): KeyStroke => ({ key });
const MOD = (key: string): KeyStroke => ({ key, mod: true });
const MOD_SHIFT = (key: string): KeyStroke => ({ key, mod: true, shift: true });

export const SHORTCUTS = [
  // General
  { id: 'general.search', scope: 'global', keys: [KEY('/')] },
  { id: 'general.newTicket', scope: 'global', keys: [KEY('c')], permission: 'ticket:write' },
  {
    id: 'general.sidebar',
    scope: 'global',
    keys: [KEY('b')],
    // 1.0.2's chord (`Admin/Shell-SidebarCollapse`), which the sidebar's own
    // toggle advertises; it carries a modifier, so it works while typing too.
    alternates: [[MOD('\\')]],
  },
  { id: 'general.shortcuts', scope: 'global', keys: [KEY('?')] },
  // Go to
  { id: 'goTo.myOpen', scope: 'global', keys: [KEY('g'), KEY('i')] },
  { id: 'goTo.unassigned', scope: 'global', keys: [KEY('g'), KEY('u')] },
  { id: 'goTo.overdue', scope: 'global', keys: [KEY('g'), KEY('o')] },
  { id: 'goTo.contacts', scope: 'global', keys: [KEY('g'), KEY('c')] },
  { id: 'goTo.helpCenter', scope: 'global', keys: [KEY('g'), KEY('k')] },
  {
    id: 'goTo.reports',
    scope: 'global',
    keys: [KEY('g'), KEY('r')],
    permission: 'report:read',
  },
  { id: 'goTo.settings', scope: 'global', keys: [KEY('g'), KEY('s')], permission: 'settings' },
  // List
  { id: 'list.next', scope: 'list', keys: [KEY('j')] },
  { id: 'list.previous', scope: 'list', keys: [KEY('k')] },
  { id: 'list.close', scope: 'list', keys: [KEY('e')], permission: 'ticket:write' },
  // Ticket
  { id: 'ticket.reply', scope: 'ticket', keys: [KEY('r')], permission: 'ticket:write' },
  { id: 'ticket.note', scope: 'ticket', keys: [KEY('n')], permission: 'ticket:write' },
  { id: 'ticket.assignee', scope: 'ticket', keys: [KEY('a')], permission: 'ticket:write' },
  { id: 'ticket.status', scope: 'ticket', keys: [KEY('s')], permission: 'ticket:write' },
  { id: 'ticket.priority', scope: 'ticket', keys: [KEY('p')], permission: 'ticket:write' },
  { id: 'ticket.tags', scope: 'ticket', keys: [KEY('t')], permission: 'ticket:write' },
  { id: 'ticket.macros', scope: 'ticket', keys: [KEY('m')], permission: 'ticket:write' },
  // Composer
  { id: 'composer.send', scope: 'composer', keys: [MOD('Enter')], permission: 'ticket:write' },
  {
    id: 'composer.sendAndClose',
    scope: 'composer',
    keys: [MOD_SHIFT('Enter')],
    permission: 'ticket:write',
  },
  {
    id: 'composer.savedReply',
    scope: 'composer',
    // Typed into an empty reply rather than pressed beside it: the composer
    // reads it from the text (`composer.tsx`), so it is the one composer
    // shortcut without a modifier, and the switch turns it off with the rest.
    keys: [KEY('/')],
    permission: 'ticket:write',
  },
] as const satisfies readonly {
  readonly id: string;
  readonly scope: ShortcutScope;
  readonly keys: readonly KeyStroke[];
  readonly alternates?: readonly (readonly KeyStroke[])[];
  readonly permission?: ShortcutPermission;
}[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

export interface Shortcut {
  readonly id: ShortcutId;
  readonly scope: ShortcutScope;
  /** One stroke, or two for a sequence. */
  readonly keys: readonly KeyStroke[];
  /** Other strokes that do the same; not drawn in the sheet. */
  readonly alternates?: readonly (readonly KeyStroke[])[];
  readonly permission?: ShortcutPermission;
}

export const SHORTCUT_LIST: readonly Shortcut[] = SHORTCUTS;

const BY_ID = new Map<ShortcutId, Shortcut>(SHORTCUT_LIST.map((entry) => [entry.id, entry]));

export const shortcutById = (id: ShortcutId): Shortcut => {
  const found = BY_ID.get(id);
  /* c8 ignore next 3 -- every id is a key of the list it was typed from. */
  if (found === undefined) {
    throw new Error(`No shortcut ${id}`);
  }
  return found;
};

/** The i18n key of an entry's name, the id under `tickets:keyboard.shortcut`. */
export const shortcutLabel = (id: ShortcutId): `tickets:keyboard.shortcut.${ShortcutId}` =>
  `tickets:keyboard.shortcut.${id}`;

export const isSequence = (shortcut: Shortcut): boolean => shortcut.keys.length > 1;

/** A shortcut the single-key switch turns off: its first stroke has no modifier. */
export const isSingleKey = (shortcut: Shortcut): boolean => shortcut.keys[0]?.mod !== true;

export const groupOf = (shortcut: Shortcut): ShortcutGroup =>
  isSequence(shortcut) ? 'goTo' : shortcut.scope === 'global' ? 'general' : shortcut.scope;

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'general',
  'goTo',
  'list',
  'ticket',
  'composer',
];
