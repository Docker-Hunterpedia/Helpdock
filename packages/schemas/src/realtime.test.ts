import { describe, expect, it } from 'vitest';
import {
  attachmentChangedSchema,
  brandRoom,
  departmentRoom,
  parseRoom,
  presenceChangedEnvelopeSchema,
  presenceSetSchema,
  REALTIME_EVENT_PAYLOADS,
  REALTIME_EVENTS,
  roomAckSchema,
  roomJoinSchema,
  roomSchema,
  ticketRoom,
} from './realtime.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const DEPARTMENT = '01937f5e-7e53-7000-8000-00000000000d';
const USER = '01937f5e-7e53-7000-8000-000000000001';

describe('rooms', () => {
  it.each([
    [brandRoom(BRAND), 'brand', BRAND],
    [departmentRoom(DEPARTMENT), 'department', DEPARTMENT],
    [ticketRoom(BRAND), 'ticket', BRAND],
  ])('parses %s', (room, kind, id) => {
    expect(parseRoom(room)).toEqual({ kind, id });
  });

  it.each([
    [`conversation:${BRAND}`, 'a kind that does not exist in v1'],
    ['brand:not-a-uuid', 'an id that is not a uuid'],
    [BRAND, 'no kind at all'],
    [`brand:${BRAND} `, 'trailing whitespace, which an anchored pattern must reject'],
  ])('refuses %s (%s)', (room) => {
    expect(parseRoom(room)).toBeNull();
    expect(roomSchema.safeParse(room).success).toBe(false);
  });
});

describe('the message schemas', () => {
  it('requires a join to name both its brand and its room', () => {
    expect(roomJoinSchema.safeParse({ room: brandRoom(BRAND) }).success).toBe(false);
    expect(roomJoinSchema.parse({ brandId: BRAND, room: brandRoom(BRAND) })).toEqual({
      brandId: BRAND,
      room: brandRoom(BRAND),
    });
  });

  it('will not let a client set itself offline: that is derived, not chosen', () => {
    expect(presenceSetSchema.safeParse({ brandId: BRAND, status: 'offline' }).success).toBe(false);
    expect(presenceSetSchema.safeParse({ brandId: BRAND, status: 'away' }).success).toBe(true);
  });

  it('names a payload schema for every server event, so nothing can be emitted unchecked', () => {
    expect(Object.keys(REALTIME_EVENT_PAYLOADS)).toEqual([
      REALTIME_EVENTS.presenceChanged,
      REALTIME_EVENTS.ticketChanged,
      REALTIME_EVENTS.ticketMessage,
      REALTIME_EVENTS.attachmentChanged,
    ]);
  });

  it('carries no URL on an attachment event, so a signed URL cannot outlive its check', () => {
    // A presigned URL is issued to a caller authorised on the parent ticket at
    // that moment; one broadcast to a room would outlive that (DOMAIN-RULES
    // §4.5). The frame names the row and the client asks for a URL of its own.
    expect(Object.keys(attachmentChangedSchema.shape).sort()).toEqual([
      'attachmentId',
      'brandId',
      'departmentId',
      'status',
      'ticketId',
    ]);
  });

  it('only reports an attachment that has finished, either way', () => {
    const frame = {
      brandId: BRAND,
      ticketId: BRAND,
      departmentId: BRAND,
      attachmentId: BRAND,
    };

    for (const status of ['ready', 'rejected', 'infected']) {
      expect(attachmentChangedSchema.safeParse({ ...frame, status }).success, status).toBe(true);
    }
    // Nothing is emitted while it is still being worked on: the composer's
    // placeholder is already showing that.
    expect(attachmentChangedSchema.safeParse({ ...frame, status: 'processing' }).success).toBe(
      false,
    );
  });

  it('carries no message body on a ticket event, so a note cannot leak over a socket', () => {
    // "The REST API is the source of truth; sockets are notifications" (§7): a
    // screen re-reads the ticket rather than patching it from a frame, and the
    // frame therefore needs no body to leak.
    const payload = REALTIME_EVENT_PAYLOADS[REALTIME_EVENTS.ticketMessage];

    expect(Object.keys(payload.shape)).toEqual([
      'brandId',
      'ticketId',
      'departmentId',
      'messageId',
      'seq',
      'kind',
      'event',
    ]);
  });

  it('gives a ticket change the department it is in now, so a queue knows it has left', () => {
    const payload = REALTIME_EVENT_PAYLOADS[REALTIME_EVENTS.ticketChanged];

    expect(Object.keys(payload.shape)).toContain('departmentId');
  });
});

describe('the envelope', () => {
  it('carries a null seq for an ephemeral event and a cursor for a replayable one', () => {
    const at = new Date().toISOString();
    const data = { userId: USER, brandId: BRAND, status: 'online' } as const;

    expect(presenceChangedEnvelopeSchema.parse({ seq: null, at, data }).seq).toBeNull();
    expect(presenceChangedEnvelopeSchema.parse({ seq: 7, at, data }).seq).toBe(7);
  });

  it('refuses a negative or fractional seq, which no cursor can be', () => {
    const at = new Date().toISOString();
    const data = { userId: USER, brandId: BRAND, status: 'online' };

    expect(presenceChangedEnvelopeSchema.safeParse({ seq: -1, at, data }).success).toBe(false);
    expect(presenceChangedEnvelopeSchema.safeParse({ seq: 1.5, at, data }).success).toBe(false);
  });
});

describe('acknowledgements', () => {
  it('is either a result or an error, never both and never neither', () => {
    expect(roomAckSchema.safeParse({ ok: true, data: { room: brandRoom(BRAND) } }).success).toBe(
      true,
    );
    expect(
      roomAckSchema.safeParse({ ok: false, error: { code: 'forbidden', message: 'no' } }).success,
    ).toBe(true);
    expect(roomAckSchema.safeParse({ ok: true, error: { code: 'forbidden' } }).success).toBe(false);
  });
});
