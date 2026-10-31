import { describe, expect, it } from 'vitest';
import { workspaceLayout } from './workspace-layout.js';

describe('workspaceLayout', () => {
  it('keeps the list beside the ticket on a wide screen, open ticket or not', () => {
    expect(workspaceLayout({ wide: true, ticketId: null })).toBe('split');
    expect(workspaceLayout({ wide: true, ticketId: 't1' })).toBe('split');
  });

  it('fills a narrow screen with the list until a ticket is opened', () => {
    expect(workspaceLayout({ wide: false, ticketId: null })).toBe('list');
  });

  it('pushes the ticket over the list on a narrow screen', () => {
    expect(workspaceLayout({ wide: false, ticketId: 't1' })).toBe('ticket');
  });
});
