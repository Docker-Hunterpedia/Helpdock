import { describe, expect, it } from 'vitest';
import { derivePresence, presenceMapOf } from './presence-status.js';

const LINA = '01937f5e-7e53-7000-8000-000000000001';
const OMAR = '01937f5e-7e53-7000-8000-000000000002';

describe('derivePresence', () => {
  it.each([
    [{ hasLiveSocket: true, explicit: undefined }, 'online'],
    [{ hasLiveSocket: true, explicit: 'online' as const }, 'online'],
    [{ hasLiveSocket: true, explicit: 'away' as const }, 'away'],
    [{ hasLiveSocket: false, explicit: undefined }, 'offline'],
  ])('%o is %s', (input, expected) => {
    expect(derivePresence(input)).toBe(expected);
  });

  it('is offline with no socket even for someone who last chose away', () => {
    // Closing the laptop wins over the toggle: the toggle only chooses between
    // the two states a reachable person can be in (DOMAIN-RULES §12).
    expect(derivePresence({ hasLiveSocket: false, explicit: 'away' })).toBe('offline');
  });
});

describe('presenceMapOf', () => {
  it('lists everyone present at the status they chose', () => {
    expect(presenceMapOf([LINA, OMAR], { [OMAR]: 'away' })).toEqual({
      [LINA]: 'online',
      [OMAR]: 'away',
    });
  });

  it('omits people with no socket, because absence is what offline means', () => {
    expect(presenceMapOf([], { [OMAR]: 'away' })).toEqual({});
  });
});
