import type { TicketStatus } from '@helpdock/schemas';
import { useShortcutHandlers } from '../../keyboard/keyboard-provider.tsx';
import type { ShortcutId } from '../../keyboard/registry.js';
import type { ComposerMode } from './composer.tsx';

/** The shortcuts an open ticket answers (M14-01). `e` is the list's, and acts on the open ticket. */
export const TICKET_SHORTCUTS = [
  'ticket.reply',
  'ticket.note',
  'ticket.assignee',
  'ticket.status',
  'ticket.priority',
  'ticket.tags',
  'ticket.macros',
  'ticket.snooze',
  'list.close',
] as const satisfies readonly ShortcutId[];

/** A details-panel control a shortcut opens. */
export type DetailsControl = 'assignee' | 'status' | 'priority' | 'tags';

/**
 * A request for the details panel to open one of its controls. `at` makes
 * two presses of the same key two requests.
 */
export interface DetailsRequest {
  readonly control: DetailsControl;
  readonly at: number;
}

/**
 * The status `e` and "Send and close" move a ticket to: the brand's first
 * closed status that is a resolution, so never Spam or Merged, which close a
 * ticket without resolving it (DOMAIN-RULES §2.1).
 */
export const closeStatusOf = (statuses: readonly TicketStatus[]): TicketStatus | null =>
  [...statuses]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .find(
      (status) => status.systemState === 'closed' && !status.excludedFromReports && !status.isSpam,
    ) ?? null;

/**
 * Attaches the ticket shortcuts while a ticket is open. `writable` is false
 * for a reader without `ticket:write` and for a merged ticket, which the api
 * would refuse to change; nothing is attached then.
 */
export function useTicketShortcuts({
  writable,
  onCompose,
  onDetails,
  onMacros,
  onSnooze,
  onClose,
}: {
  readonly writable: boolean;
  onCompose(mode: ComposerMode): void;
  onDetails(control: DetailsControl): void;
  onMacros(): void;
  /** Null when the ticket is closed: nothing to put away (DOMAIN-RULES §2.2). */
  readonly onSnooze: (() => void) | null;
  /** Null when there is nothing to close into, or the ticket is already closed. */
  readonly onClose: (() => void) | null;
}): void {
  const when = (run: () => void): (() => void) | null => (writable ? run : null);

  useShortcutHandlers<(typeof TICKET_SHORTCUTS)[number]>({
    'ticket.reply': when(() => {
      onCompose('reply');
    }),
    'ticket.note': when(() => {
      onCompose('note');
    }),
    'ticket.assignee': when(() => {
      onDetails('assignee');
    }),
    'ticket.status': when(() => {
      onDetails('status');
    }),
    'ticket.priority': when(() => {
      onDetails('priority');
    }),
    'ticket.tags': when(() => {
      onDetails('tags');
    }),
    'ticket.macros': when(onMacros),
    'ticket.snooze': writable ? onSnooze : null,
    'list.close': writable ? onClose : null,
  });
}
