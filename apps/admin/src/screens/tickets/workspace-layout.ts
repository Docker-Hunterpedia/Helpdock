/**
 * Which columns the ticket workspace draws (DESIGN §6.5, M14-22).
 *
 * From 1024 px the list and the ticket sit side by side (`split`). Below it
 * the screen is list-first: the list fills it until a ticket is opened, and
 * then the ticket does, with a back button to the list.
 */
export type WorkspaceLayout = 'split' | 'list' | 'ticket';

export function workspaceLayout({
  wide,
  ticketId,
}: {
  readonly wide: boolean;
  readonly ticketId: string | null;
}): WorkspaceLayout {
  if (wide) {
    return 'split';
  }

  return ticketId === null ? 'list' : 'ticket';
}
