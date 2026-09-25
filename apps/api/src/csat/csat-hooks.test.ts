import type {
  DbTransaction,
  Ticket as TicketRow,
  TicketStatus as TicketStatusRow,
} from '@helpdock/db';
import { type BrandSettings, defaultBrandSettings } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { TicketLifecycleRepository } from '../tickets/lifecycle/lifecycle.repository.js';
import { CSAT_EVENTS } from './csat-events.js';
import { CsatLifecycleHooks } from './csat-hooks.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const CLOSED_AT = new Date('2026-09-20T10:00:00.000Z');
const LATER = new Date('2026-09-20T10:00:09.000Z');

const fire = async (settings: BrandSettings | undefined, closedAt: Date | null = CLOSED_AT) => {
  const written: { event: string; payload: unknown }[] = [];
  const tx = {
    insert: () => ({
      values: (row: { event: string; payload: unknown }) => {
        written.push(row);
        return { returning: () => Promise.resolve([{ id: 'outbox-1' }]) };
      },
    }),
  } as unknown as DbTransaction;
  const lifecycle = {
    brandSettings: () => Promise.resolve(settings),
  } as unknown as TicketLifecycleRepository;

  await new CsatLifecycleHooks(lifecycle).onClosedForCsat(tx, {
    brandId: BRAND,
    ticket: { id: TICKET, closedAt } as TicketRow,
    status: {} as TicketStatusRow,
    at: LATER,
  });

  return written;
};

describe('CsatLifecycleHooks', () => {
  it('asks the worker for a survey of this close when the brand has CSAT on', async () => {
    expect(await fire(defaultBrandSettings())).toEqual([
      expect.objectContaining({
        event: CSAT_EVENTS.requested,
        payload: { ticketId: TICKET, closedAt: CLOSED_AT.toISOString() },
      }),
    ]);
  });

  it('asks for nothing when the brand has CSAT off', async () => {
    expect(await fire({ ...defaultBrandSettings(), csatEnabled: false })).toEqual([]);
  });

  it('asks for nothing when the brand has vanished under the request', async () => {
    expect(await fire(undefined)).toEqual([]);
  });

  it('names the transition’s own moment when the row carries no close time', async () => {
    const [row] = await fire(defaultBrandSettings(), null);

    expect(row?.payload).toEqual({ ticketId: TICKET, closedAt: LATER.toISOString() });
  });
});
