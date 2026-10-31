import type { TicketStatus } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { isSingleStatusView } from './single-status.js';

const status = (id: string, systemState: TicketStatus['systemState']): TicketStatus =>
  ({ id, systemState }) as TicketStatus;

const STATUSES = [
  status('open', 'open'),
  status('waiting', 'on_hold'),
  status('pending', 'on_hold'),
  status('closed', 'closed'),
];

const view = (
  statusId: string[],
  systemState: TicketStatus['systemState'][],
): Parameters<typeof isSingleStatusView>[0] => ({ statusId, systemState });

describe('isSingleStatusView', () => {
  it.each([
    ['one status picked by name', view(['waiting'], []), true],
    ['one system state that one status has', view([], ['closed']), true],
    ['one system state that two statuses share', view([], ['on_hold']), false],
    ['two statuses', view(['open', 'waiting'], []), false],
    ['the live states together', view([], ['open', 'on_hold', 'escalated']), false],
    ['no status filter at all', view([], []), false],
    ['one system state with no status of that state', view([], ['escalated']), false],
  ])('%s', (_name, filters, expected) => {
    expect(isSingleStatusView(filters, STATUSES)).toBe(expected);
  });
});
