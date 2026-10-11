import { describe, expect, it } from 'vitest';
import { instantOf, QUOTE_MAX_LENGTH, quoteLine, unsentExternalId } from './instagram-rules.js';

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

describe('quoteLine', () => {
  it('leads the quoted message with "> " on one line', () => {
    expect(quoteLine('Yes, we ship worldwide.')).toBe('> Yes, we ship worldwide.');
    expect(quoteLine('First line\n\nSecond   line')).toBe('> First line Second line');
  });

  it('has nothing to quote in a message with no text', () => {
    expect(quoteLine('')).toBe('');
    expect(quoteLine(' \n ')).toBe('');
  });

  it('drops the quote the quoted message itself opened with', () => {
    expect(quoteLine('> older words\n\nThe answer')).toBe('> The answer');
    expect(quoteLine('> older words')).toBe('');
  });

  it('keeps a ">" that is not at the start of a line', () => {
    expect(quoteLine('1 > 0')).toBe('> 1 > 0');
  });

  it('cuts a long message at the limit, whole code points, with an ellipsis', () => {
    const long = 'ب'.repeat(QUOTE_MAX_LENGTH + 20);
    const line = quoteLine(long);

    expect([...line]).toHaveLength(2 + QUOTE_MAX_LENGTH + 1);
    expect(line.endsWith('…')).toBe(true);
    expect(quoteLine('ب'.repeat(QUOTE_MAX_LENGTH))).toBe(`> ${'ب'.repeat(QUOTE_MAX_LENGTH)}`);
  });

  it('never splits an emoji', () => {
    const line = quoteLine('😀'.repeat(QUOTE_MAX_LENGTH + 5));

    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect([...line]).toHaveLength(2 + QUOTE_MAX_LENGTH + 1);
  });
});
