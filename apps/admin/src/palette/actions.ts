import type { ShortcutId } from '../keyboard/registry.js';

/**
 * The registry shortcuts the palette offers as actions (M14-05): the ones a
 * person would look for by name. The `g` sequences are the "Go to" pages, the
 * list's `j`/`k` and the composer's keys act on a focus the palette takes
 * away, and `⌘K` is the palette itself.
 *
 * An action is offered while a screen has attached its handler and the person
 * may use it (`useKeyboard().isAvailable`), so "Reply" is there with a ticket
 * open and not on the contacts page, and a Viewer is offered none of the ones
 * that write. Each is worded in `admin:palette.actions.<id>`.
 */
export const PALETTE_SHORTCUT_ACTIONS = [
  'general.newTicket',
  'general.search',
  'general.shortcuts',
  'general.sidebar',
  'ticket.reply',
  'ticket.note',
  'ticket.assignee',
  'ticket.status',
  'ticket.priority',
  'ticket.tags',
  'ticket.snooze',
  'ticket.macros',
  'list.close',
] as const satisfies readonly ShortcutId[];

export type PaletteShortcutAction = (typeof PALETTE_SHORTCUT_ACTIONS)[number];
