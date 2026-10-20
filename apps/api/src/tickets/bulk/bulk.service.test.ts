import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TicketingFailure } from '../../brands/ticketing-failure.js';
import { TicketLifecycleFailure } from '../lifecycle/lifecycle-failure.js';
import { BULK_APPLY_RULE, BULK_PREVIEW_RULE, BulkService, refusalCode } from './bulk.service.js';

const BRAND = '0199f4b2-0000-7000-8000-0000000000b1';
const TICKET = '0199f4b2-2222-7000-8000-0000000000aa';
const OPERATION = '0199f4b2-aaaa-7000-8000-000000000001';

const service = (allowed: boolean) => {
  const limiter = { consume: vi.fn(async () => allowed) };
  const bulk = new BulkService({
    tickets: {} as never,
    ticketReads: {} as never,
    spam: {} as never,
    tags: {} as never,
    bulk: {} as never,
    limiter,
  });

  return { bulk, limiter };
};

const request = (mode: 'preview' | 'apply') => ({
  ticketIds: [TICKET],
  changes: { priority: 'high' as const },
  mode,
  ...(mode === 'apply' ? { expect: [TICKET] } : {}),
});

describe('refusalCode', () => {
  it('carries the code of the refusals a single edit makes', () => {
    expect(refusalCode(new TicketLifecycleFailure('ticket-closed'))).toBe('ticket-closed');
    expect(refusalCode(new TicketingFailure('assignee-above-actor'))).toBe('assignee-above-actor');
  });

  it('names what else a single edit can refuse with', () => {
    expect(refusalCode(new NotFoundException('No such status'))).toBe('unknown-reference');
    expect(refusalCode(new BadRequestException('That person holds no role'))).toBe('invalid');
    expect(refusalCode(new ForbiddenException())).toBe('forbidden');
    expect(refusalCode(new ConflictException())).toBe('conflict');
  });

  it('is null for an error that is not a refusal, so it is not mistaken for one', () => {
    expect(refusalCode(new Error('connection lost'))).toBeNull();
    expect(refusalCode('nope')).toBeNull();
  });
});

describe('BulkService access', () => {
  const visitor = { type: 'visitor', id: 'v' } as never;
  const apiKey = { type: 'apikey', id: 'k' } as never;

  it.each([
    ['a visitor', visitor],
    ['an API key', apiKey],
  ])('refuses %s, and spends no budget on it', async (_name, principal) => {
    const { bulk, limiter } = service(true);

    await expect(bulk.run(BRAND, principal, request('preview'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(bulk.undo(BRAND, principal, OPERATION)).rejects.toBeInstanceOf(ForbiddenException);
    expect(limiter.consume).not.toHaveBeenCalled();
  });
});

describe('BulkService rate limits', () => {
  const staff = { type: 'staff', id: 'u1' } as never;

  it('answers 429 when the apply budget is spent, before touching any ticket', async () => {
    const { bulk, limiter } = service(false);

    await expect(bulk.run(BRAND, staff, request('apply'))).rejects.toMatchObject({ status: 429 });
    expect(limiter.consume).toHaveBeenCalledWith(BULK_APPLY_RULE, `${BRAND}:u1`);
  });

  it('keeps previews on their own, looser budget', async () => {
    const { bulk, limiter } = service(false);

    await expect(bulk.run(BRAND, staff, request('preview'))).rejects.toMatchObject({ status: 429 });
    expect(limiter.consume).toHaveBeenCalledWith(BULK_PREVIEW_RULE, `${BRAND}:u1`);
    expect(BULK_PREVIEW_RULE.limit).toBeGreaterThan(BULK_APPLY_RULE.limit);
  });

  it('shares the apply budget with Undo', async () => {
    const { bulk, limiter } = service(false);

    await expect(bulk.undo(BRAND, staff, OPERATION)).rejects.toMatchObject({ status: 429 });
    expect(limiter.consume).toHaveBeenCalledWith(BULK_APPLY_RULE, `${BRAND}:u1`);
  });
});
