import { describe, expect, it } from 'vitest';
import { batchMessageId, localHour } from './email-engine.js';

describe('batchMessageId', () => {
  it('is derived from the batch and the install’s host, so a resend carries the same id', () => {
    const id = '0199f4b2-5555-7000-8000-000000000001';

    expect(batchMessageId(id, 'https://support.example.com/')).toBe(
      `<notify.batch.${id}@support.example.com>`,
    );
    expect(batchMessageId(id, 'https://support.example.com:8443')).toBe(
      batchMessageId(id, 'https://support.example.com'),
    );
  });
});

describe('localHour', () => {
  it('reads the hour in the zone, following summer and winter time', () => {
    expect(localHour(new Date('2026-10-24T06:00:00.000Z'), 'Europe/Berlin')).toBe(8);
    expect(localHour(new Date('2026-10-25T06:00:00.000Z'), 'Europe/Berlin')).toBe(7);
    expect(localHour(new Date('2026-10-25T07:00:00.000Z'), 'Asia/Riyadh')).toBe(10);
    expect(localHour(new Date('2026-10-25T23:30:00.000Z'), 'UTC')).toBe(23);
  });

  it('says 0 for midnight, not 24', () => {
    expect(localHour(new Date('2026-10-20T00:00:00.000Z'), 'UTC')).toBe(0);
  });
});
