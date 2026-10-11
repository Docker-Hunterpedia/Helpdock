import { describe, expect, it } from 'vitest';
import { instantOf, unsentExternalId } from './instagram-rules.js';

describe('unsentExternalId', () => {
  it('names the message the line is about and cannot be a real mid', () => {
    expect(unsentExternalId('m_abc')).toBe('unsent:m_abc');
    // A real mid never contains a colon, so the marker cannot collide with a message.
    expect(unsentExternalId('m_abc')).not.toBe('m_abc');
  });
});

describe('instantOf', () => {
  const now = new Date('2026-10-11T08:00:00Z');

  it('is Meta’s time when it is not in the future', () => {
    const reported = new Date('2026-10-11T07:59:30Z');
    expect(instantOf(reported, now)).toBe(reported);
    expect(instantOf(now, now)).toBe(now);
  });

  it('is now for a missing time and for one that claims to be ahead', () => {
    expect(instantOf(null, now)).toBe(now);
    expect(instantOf(new Date('2026-10-12T08:00:00Z'), now)).toBe(now);
  });
});
