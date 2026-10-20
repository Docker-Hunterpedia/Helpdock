import type { Ticket, TicketRouting } from '@helpdock/schemas';
import { MOCK_DEPARTMENTS, MOCK_SELF_ID } from '../staff/mock-api.js';

/**
 * M14-08's trails for the ticket fixture, as `GET /tickets/:id/routing` would
 * compose them (artboard `Admin/Ticket-Routing`).
 *
 * - `HD-1042` arrived by email at the Support mailbox, then AI triage raised
 *   it and the rotation gave it to Lina: the expanded artboard.
 * - `HD-1041` came through the widget into the brand's first department, and
 *   a rule since deleted raised its priority.
 * - `HD-1028` cannot be read, which is the card's failure path.
 * - Every other ticket predates 1.1 and says only how it arrived.
 */

export const MOCK_ROUTING_FAILS = 1028;

const [SUPPORT] = MOCK_DEPARTMENTS;
const support = { id: SUPPORT?.id ?? '', name: SUPPORT?.name ?? null, nameAr: 'الدعم' };

const TRIAGE_RULE = '0192c3f0-1a2b-7c3d-8e4f-0000000f0001';
const DELETED_RULE = '0192c3f0-1a2b-7c3d-8e4f-0000000f0002';

const MINUTE = 60_000;

export const mockRouting = (ticket: Ticket): TicketRouting => {
  const at = (minutes: number): string =>
    new Date(Date.parse(ticket.createdAt) + minutes * MINUTE).toISOString();

  switch (ticket.number) {
    case 1042:
      return {
        origin: {
          kind: 'recorded',
          channel: 'email',
          entry: 'mailbox',
          address: 'support@helpdock.test',
          reason: 'entry_department',
          department: support,
        },
        steps: [
          {
            at: at(1),
            change: { kind: 'priority', from: 'medium', to: 'urgent' },
            by: { kind: 'ai_triage', ruleId: TRIAGE_RULE, name: 'Triage new email' },
          },
          {
            at: at(2),
            change: { kind: 'assigned', assignee: { id: MOCK_SELF_ID, name: 'Lina Haddad' } },
            by: { kind: 'assignment', mode: 'round_robin' },
          },
        ],
      };
    case 1041:
      return {
        origin: {
          kind: 'recorded',
          channel: 'chat',
          entry: 'widget',
          address: null,
          reason: 'brand_first_department',
          department: support,
        },
        steps: [
          {
            at: at(1),
            change: { kind: 'priority', from: 'medium', to: 'high' },
            by: { kind: 'rule', ruleId: DELETED_RULE, name: null },
          },
        ],
      };
    case MOCK_ROUTING_FAILS:
      throw new Error('The routing trail could not be read');
    default:
      return { origin: { kind: 'unrecorded', channel: ticket.channel }, steps: [] };
  }
};
