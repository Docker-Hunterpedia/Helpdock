import type { PresenceMap } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { applyPresenceChange, statusOf } from './presence-map.js';

const BRAND = '0192c3f0-1a2b-7c3d-8e4f-000000000001';
const LINA = '0192c3f0-1a2b-7c3d-8e4f-00000000000a';
const OMAR = '0192c3f0-1a2b-7c3d-8e4f-00000000000b';

const change = (userId: string, status: 'online' | 'away' | 'offline') => ({
  userId,
  brandId: BRAND,
  status,
});

describe('applyPresenceChange', () => {
  it('adds someone who has just arrived', () => {
    expect(applyPresenceChange({}, change(LINA, 'online'))).toEqual({ [LINA]: 'online' });
  });

  it('moves someone between the two reachable states', () => {
    expect(applyPresenceChange({ [LINA]: 'online' }, change(LINA, 'away'))).toEqual({
      [LINA]: 'away',
    });
  });

  it('removes someone who went offline, because absence is what offline means', () => {
    expect(
      applyPresenceChange({ [LINA]: 'away', [OMAR]: 'online' }, change(LINA, 'offline')),
    ).toEqual({ [OMAR]: 'online' });
  });

  it.each([
    ['a status that has not changed', { [LINA]: 'online' } as PresenceMap, change(LINA, 'online')],
    ['someone who was already absent', {} as PresenceMap, change(LINA, 'offline')],
  ])('answers with the same object for %s, so React does not re-render', (_name, map, applied) => {
    expect(applyPresenceChange(map, applied)).toBe(map);
  });
});

describe('statusOf', () => {
  it('reads a present person and calls anyone else offline', () => {
    expect(statusOf({ [LINA]: 'away' }, LINA)).toBe('away');
    expect(statusOf({ [LINA]: 'away' }, OMAR)).toBe('offline');
  });
});
