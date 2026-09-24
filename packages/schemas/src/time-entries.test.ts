import { describe, expect, it } from 'vitest';
import { messageCreateRequestSchema } from './ticket.js';
import { MAX_TIME_ENTRY_SECONDS, timeEntryCreateRequestSchema } from './time-entries.js';

describe('timeEntryCreateRequestSchema', () => {
  it('takes the dialog’s largest entry, 24 hours and 59 minutes', () => {
    expect(MAX_TIME_ENTRY_SECONDS).toBe(24 * 3600 + 59 * 60);
    expect(
      timeEntryCreateRequestSchema.safeParse({ seconds: MAX_TIME_ENTRY_SECONDS }).success,
    ).toBe(true);
  });

  it.each([0, -60, MAX_TIME_ENTRY_SECONDS + 1, 90.5])('refuses %s seconds', (seconds) => {
    expect(timeEntryCreateRequestSchema.safeParse({ seconds }).success).toBe(false);
  });

  it('trims the note', () => {
    expect(timeEntryCreateRequestSchema.parse({ seconds: 60, note: '  Called  ' })).toEqual({
      seconds: 60,
      note: 'Called',
    });
  });
});

describe('messageCreateRequestSchema.timeSpentSeconds', () => {
  it('carries the per-reply timer under the same bounds as an entry', () => {
    const reply = { kind: 'public', bodyHtml: '<p>Hi</p>' } as const;

    expect(messageCreateRequestSchema.parse({ ...reply, timeSpentSeconds: 45 })).toMatchObject({
      timeSpentSeconds: 45,
    });
    expect(messageCreateRequestSchema.safeParse({ ...reply, timeSpentSeconds: 0 }).success).toBe(
      false,
    );
  });
});
