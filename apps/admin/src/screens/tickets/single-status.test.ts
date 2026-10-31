import type { TicketStatus } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { singleStatusOf } from './single-status.js';

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
): Parameters<typeof singleStatusOf>[0] => ({ statusId, systemState });

describe('singleStatusOf', () => {
  it.each([
    ['one status picked by name', view(['waiting'], []), 'waiting'],
    ['one system state that one status has', view([], ['closed']), 'closed'],
    ['one system state that two statuses share', view([], ['on_hold']), null],
    ['two statuses', view(['open', 'waiting'], []), null],
    ['the live states together', view([], ['open', 'on_hold', 'escalated']), null],
    ['no status filter at all', view([], []), null],
    ['one system state with no status of that state', view([], ['escalated']), null],
  ])('%s', (_name, filters, expected) => {
    expect(singleStatusOf(filters, STATUSES)).toBe(expected);
  });
});
