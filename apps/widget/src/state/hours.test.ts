import { describe, expect, it } from 'vitest';
import type { Availability, ConversationHours } from '../transport/types.js';
import { closedUntil, teamHours } from './hours.js';

const NOW = new Date('2026-09-25T17:40:00Z');
const OPENING = '2026-09-27T05:00:00Z';

const ofTeam: ConversationHours = {
  open: false,
  next_open_at: '2026-09-28T06:00:00Z',
  timezone: 'Asia/Riyadh',
};

const availability = (fields: Partial<Availability> = {}): Availability => ({
  state: 'closed',
  next_open_at: OPENING,
  timezone: 'Asia/Dubai',
  agents_online: [],
  ...fields,
});

describe('teamHours', () => {
  it("prefers the hours of the conversation to the brand's availability", () => {
    expect(teamHours({ hours: ofTeam }, availability())).toBe(ofTeam);
  });

  it('falls back to the brand’s availability for a server that sends no hours', () => {
    expect(teamHours({}, availability())).toEqual({
      open: false,
      next_open_at: OPENING,
      timezone: 'Asia/Dubai',
    });
    expect(teamHours(null, availability({ state: 'online', next_open_at: null }))).toEqual({
      open: true,
      next_open_at: null,
      timezone: 'Asia/Dubai',
    });
  });

  it('counts an open brand without anybody online as open, because that is a matter of presence', () => {
    expect(teamHours(null, availability({ state: 'open_offline', next_open_at: null }))?.open).toBe(
      true,
    );
  });

  it('is unknown when there are neither hours nor availability', () => {
    expect(teamHours({}, null)).toBeNull();
    expect(teamHours(null, null)).toBeNull();
  });
});

describe('closedUntil', () => {
  it('is the opening and the zone while the team is closed', () => {
    expect(closedUntil(ofTeam, NOW)).toEqual({
      next_open_at: '2026-09-28T06:00:00Z',
      timezone: 'Asia/Riyadh',
    });
  });

  it('is null for unknown hours, so the widget never guesses a time', () => {
    expect(closedUntil(null, NOW)).toBeNull();
  });

  it('is null while open', () => {
    expect(closedUntil({ open: true, next_open_at: null, timezone: 'UTC' }, NOW)).toBeNull();
  });

  it('is null at the opening and after it, when the page stayed open past it', () => {
    expect(closedUntil(ofTeam, new Date('2026-09-28T06:00:00Z'))).toBeNull();
    expect(closedUntil(ofTeam, new Date('2026-09-28T06:00:01Z'))).toBeNull();
    expect(closedUntil(ofTeam, new Date('2026-09-28T05:59:59Z'))).not.toBeNull();
  });

  it('keeps a null opening for a calendar that never opens', () => {
    expect(closedUntil({ open: false, next_open_at: null, timezone: 'Asia/Dubai' }, NOW)).toEqual({
      next_open_at: null,
      timezone: 'Asia/Dubai',
    });
  });
});
