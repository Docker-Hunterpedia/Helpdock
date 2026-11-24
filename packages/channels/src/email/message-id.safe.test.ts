import { describe, expect, it } from 'vitest';
import { safeMessageId } from './message-id.js';

describe('safeMessageId', () => {
  it('returns a bare id, with or without brackets', () => {
    expect(safeMessageId('msg-1205@mail.example.com')).toBe('msg-1205@mail.example.com');
    expect(safeMessageId('<msg-1205@mail.example.com>')).toBe('msg-1205@mail.example.com');
  });

  it.each([
    'a@b.c\r\nBcc: x@y.z',
    'a@b.c d@e.f',
    '<a@b.c><d@e.f>',
    'no-at-sign',
    'a@b@c.d',
    '<script>@x.y',
    '"quoted"@x.y',
    '',
    `${'a'.repeat(300)}@x.y`,
  ])('refuses %j', (value) => {
    expect(safeMessageId(value)).toBeUndefined();
  });

  it('refuses null and undefined', () => {
    expect(safeMessageId(null)).toBeUndefined();
    expect(safeMessageId(undefined)).toBeUndefined();
  });
});
