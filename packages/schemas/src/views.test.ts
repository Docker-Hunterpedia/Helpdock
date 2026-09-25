import { describe, expect, it } from 'vitest';
import {
  ticketViewCreateRequestSchema,
  ticketViewFiltersSchema,
  ticketViewUpdateRequestSchema,
} from './views.js';

const UUID = '0192c3f0-1a2b-7c3d-8e4f-000000000001';

describe('ticketViewFiltersSchema', () => {
  it('is the list query less the cursor and the page size', () => {
    const parsed = ticketViewFiltersSchema.parse({
      systemState: ['open'],
      cursor: 'abc',
      limit: 10,
    });

    expect(parsed).toEqual({ systemState: ['open'], sort: 'updatedAt', direction: 'desc' });
  });

  it('refuses a filter the list itself would refuse', () => {
    expect(ticketViewFiltersSchema.safeParse({ assigneeId: ['nobody'] }).success).toBe(false);
  });

  it('keeps `me` and `overdue`, which the api resolves per reader', () => {
    expect(ticketViewFiltersSchema.parse({ assigneeId: ['me'], overdue: true })).toMatchObject({
      assigneeId: ['me'],
      overdue: true,
    });
  });
});

describe('ticketViewCreateRequestSchema', () => {
  it('is personal unless it says otherwise', () => {
    const parsed = ticketViewCreateRequestSchema.parse({ name: 'Mine', filters: {} });

    expect(parsed.visibility).toEqual({ kind: 'personal' });
  });

  it('needs at least one department to share with departments', () => {
    const result = ticketViewCreateRequestSchema.safeParse({
      name: 'Billing',
      filters: {},
      visibility: { kind: 'departments', departmentIds: [] },
    });

    expect(result.success).toBe(false);
  });

  it('trims the name, so a name of spaces is no name', () => {
    expect(ticketViewCreateRequestSchema.safeParse({ name: '   ', filters: {} }).success).toBe(
      false,
    );
  });

  it('accepts a department share', () => {
    const parsed = ticketViewCreateRequestSchema.parse({
      name: 'Billing',
      filters: {},
      visibility: { kind: 'departments', departmentIds: [UUID] },
    });

    expect(parsed.visibility).toEqual({ kind: 'departments', departmentIds: [UUID] });
  });
});

describe('ticketViewUpdateRequestSchema', () => {
  it('refuses an empty change', () => {
    expect(ticketViewUpdateRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts hiding alone', () => {
    expect(ticketViewUpdateRequestSchema.parse({ hidden: true })).toEqual({ hidden: true });
  });
});
