import type { DbTransaction, RetentionSettingsRow } from '@helpdock/db';
import type { RetentionUpdateRequest } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import type { RetentionRepository, TicketPurgeKind } from './retention.repository.js';
import { RetentionService } from './retention.service.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const ADMIN = '01937f5e-7e53-7000-8000-00000000000b';
const NOW = new Date('2026-09-24T12:00:00.000Z');

const FORM: RetentionUpdateRequest = {
  closedTickets: { kind: 'days', days: 365 },
  spamTicketDays: 14,
  aiCallDays: 90,
  searchLogDays: 180,
  auditLogDays: 365,
  visitorSessionDays: 30,
};

interface Recorded {
  row: RetentionSettingsRow | undefined;
  counted: { kind: TicketPurgeKind; cutoff: Date }[];
  audit: Record<string, unknown>[];
}

/** A repository over one brand's row, counting nothing but what it was asked. */
const fakes = () => {
  const recorded: Recorded = { row: undefined, counted: [], audit: [] };
  const repository = {
    find: async () => recorded.row,
    save: async (_tx: DbTransaction, brandId: string, values: Partial<RetentionSettingsRow>) => {
      recorded.row = {
        brandId,
        updatedBy: ADMIN,
        updatedAt: NOW,
        lastRunAt: null,
        lastRunCounts: {},
        ...values,
      } as RetentionSettingsRow;
    },
    countTickets: async (
      _tx: DbTransaction,
      _brand: string,
      kind: TicketPurgeKind,
      cutoff: Date,
    ) => {
      recorded.counted.push({ kind, cutoff });
      return kind === 'closed' ? 12 : 62;
    },
    countAuditLog: async () => 0,
  } as unknown as RetentionRepository;
  const tx = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => void recorded.audit.push(row),
    }),
  } as unknown as DbTransaction;

  return { recorded, tx, service: new RetentionService(repository, () => NOW) };
};

describe('RetentionService.overview', () => {
  it('serves the defaults and counts nothing for closed tickets kept forever', async () => {
    const { service, tx, recorded } = fakes();

    const overview = await service.overview(tx, BRAND);

    expect(overview.settings.closedTickets).toEqual({ kind: 'never' });
    expect(overview.preview).toEqual({
      closedTickets: null,
      spamTickets: 62,
      aiCalls: null,
      searchLog: null,
      auditLog: 0,
      visitorSessions: null,
    });
    expect(recorded.counted.map((entry) => entry.kind)).toEqual(['spam']);
    expect(overview.lastRun).toBeNull();
  });
});

describe('RetentionService.update', () => {
  it('saves the form and previews what the new windows would purge', async () => {
    const { service, tx, recorded } = fakes();

    const overview = await service.update({ tx, brandId: BRAND, actorId: ADMIN }, FORM);

    expect(overview.settings).toEqual(FORM);
    expect(overview.preview.closedTickets).toBe(12);
    expect(recorded.counted.find((entry) => entry.kind === 'closed')?.cutoff.toISOString()).toBe(
      '2025-09-24T12:00:00.000Z',
    );
  });

  it('audits the change as before and after, in days', async () => {
    const { service, tx, recorded } = fakes();

    await service.update({ tx, brandId: BRAND, actorId: ADMIN }, FORM);

    expect(recorded.audit).toEqual([
      expect.objectContaining({
        brandId: BRAND,
        actorType: 'staff',
        actorId: ADMIN,
        action: 'retention.updated',
        meta: {
          before: expect.objectContaining({ closedTickets: { kind: 'never' } }),
          after: FORM,
        },
      }),
    ]);
  });
});
