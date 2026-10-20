import type { TicketStatus } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { closeStatusOf } from './ticket-shortcuts.js';

const status = (
  id: string,
  systemState: TicketStatus['systemState'],
  sortOrder: number,
  flags: Partial<Pick<TicketStatus, 'excludedFromReports' | 'isSpam'>> = {},
): TicketStatus => ({
  id: `0192c3f0-1a2b-7c3d-8e4f-0000000000${id}`,
  name: id,
  nameAr: null,
  systemState,
  pausesSla: false,
  awaitingCustomer: false,
  isDefault: false,
  isSystem: true,
  excludedFromReports: flags.excludedFromReports ?? false,
  isSpam: flags.isSpam ?? false,
  sortOrder,
  color: 'success',
});

describe('closeStatusOf', () => {
  it('is the first closed status by the brand’s order', () => {
    const resolved = status('a2', 'closed', 3);
    const done = status('a3', 'closed', 2);

    expect(closeStatusOf([status('a1', 'open', 1), resolved, done])).toBe(done);
  });

  it('is never Spam or Merged, which close without resolving', () => {
    const spam = status('b1', 'closed', 1, { excludedFromReports: true, isSpam: true });
    const merged = status('b2', 'closed', 2, { excludedFromReports: true });
    const closed = status('b3', 'closed', 3);

    expect(closeStatusOf([spam, merged, closed])).toBe(closed);
    expect(closeStatusOf([spam, merged])).toBeNull();
  });
});
