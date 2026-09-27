import { type AuditLogEntry, INSTALL_SCOPE_BRAND_ID } from '@helpdock/db';
import { describe, expect, it } from 'vitest';
import { decodeAuditCursor, encodeAuditCursor, InvalidAuditCursorError } from './audit-cursor.js';
import { toRecord } from './audit-log.service.js';

const BRAND = '01937f5e-7e53-7000-8000-0000000000b1';
const USER = '01937f5e-7e53-7000-8000-000000000001';

const row = (overrides: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  id: '01937f5e-7e53-7000-8000-0000000000e1',
  brandId: BRAND,
  actorType: 'staff',
  actorId: USER,
  action: 'macro.updated',
  targetType: 'macro',
  targetId: 'm-1',
  meta: {},
  ip: '10.0.4.22',
  requestId: 'req-1',
  userAgent: 'Mozilla/5.0 Firefox/130.0',
  createdAt: new Date('2026-09-27T13:41:09Z'),
  ...overrides,
});

describe('toRecord', () => {
  const names = new Map([[USER, 'Omar Nasser']]);
  const brands = new Map([[BRAND, 'Helpdock']]);

  it('names the actor and the brand, and says where the request came from', () => {
    expect(toRecord(row(), names, brands)).toMatchObject({
      brandId: BRAND,
      brandName: 'Helpdock',
      actorName: 'Omar Nasser',
      ip: '10.0.4.22',
      requestId: 'req-1',
      createdAt: '2026-09-27T13:41:09.000Z',
    });
  });

  it('reads an install-wide row as belonging to no brand', () => {
    expect(toRecord(row({ brandId: INSTALL_SCOPE_BRAND_ID }), names, brands)).toMatchObject({
      brandId: null,
      brandName: null,
    });
  });

  it('names nobody for a worker, and falls back to the id M0 kept in meta', () => {
    const record = toRecord(
      row({
        actorType: 'system',
        actorId: 'maintenance.retention',
        requestId: null,
        meta: { requestId: 'req-old', purged: 212 },
      }),
      names,
      brands,
    );

    expect(record).toMatchObject({ actorName: null, requestId: 'req-old' });
    expect(record.details).toEqual([{ field: 'purged', value: '212', secret: false }]);
  });

  it('never returns a stored secret', () => {
    const record = toRecord(
      row({ meta: { before: { 'smtp.password': 'a' }, after: { 'smtp.password': 'b' } } }),
      names,
      brands,
    );

    expect(record.changes[0]).toMatchObject({ before: '[redacted]', after: '[redacted]' });
  });
});

describe('the audit cursor', () => {
  it('round-trips', () => {
    const cursor = { at: '2026-09-27T13:41:09.000Z', id: USER };

    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
  });

  it.each(['not base64 json', Buffer.from('{"at":"x","id":"y"}').toString('base64url')])(
    'refuses %s',
    (value) => {
      expect(() => decodeAuditCursor(value)).toThrow(InvalidAuditCursorError);
    },
  );
});
