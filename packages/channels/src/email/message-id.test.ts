import { describe, expect, it } from 'vitest';
import {
  messageIdDomain,
  outboundMessageId,
  safeMessageId,
  storableReferences,
} from './message-id.js';

const ID = '0190a8a5-7c1e-7000-8000-000000000001';

describe('outboundMessageId', () => {
  it('is the same id every time it is asked for the same message', () => {
    const first = outboundMessageId({ kind: 'reply', id: ID, fromAddress: 'billing@helpdock.io' });

    expect(first).toBe(`<hd.m.${ID}@helpdock.io>`);
    expect(outboundMessageId({ kind: 'reply', id: ID, fromAddress: 'billing@helpdock.io' })).toBe(
      first,
    );
  });

  it('keeps a reply, the two auto-replies, a transcript and a survey of one id apart', () => {
    const ids = (['reply', 'acknowledgment', 'out_of_hours', 'transcript', 'csat'] as const).map(
      (kind) => outboundMessageId({ kind, id: ID, fromAddress: 'a@b.example' }),
    );

    expect(new Set(ids).size).toBe(5);
    expect(ids[3]).toBe(`<hd.t.${ID}@b.example>`);
    expect(ids[4]).toBe(`<hd.c.${ID}@b.example>`);
  });
});

describe('messageIdDomain', () => {
  it('lower-cases the domain and drops what a dot-atom cannot hold', () => {
    expect(messageIdDomain('Support@Help Dock.IO')).toBe('helpdock.io');
  });

  it('falls back to a reserved domain when there is none', () => {
    expect(messageIdDomain('not-an-address')).toBe('helpdock.invalid');
  });
});

describe('storableReferences (M14-31)', () => {
  it('keeps well-formed ids in order and drops an over-long or malformed one', () => {
    const long = `${'a'.repeat(1204)}@x.y`;

    expect(storableReferences(['a@x.y', long, 'bad id@x.y', '<b@x.y>'])).toEqual([
      'a@x.y',
      'b@x.y',
    ]);
  });

  it('keeps the newest hundred', () => {
    const ids = Array.from({ length: 150 }, (_, index) => `m${String(index)}@x.y`);
    const kept = storableReferences(ids);

    expect(kept).toHaveLength(100);
    expect(kept[0]).toBe('m50@x.y');
  });
});

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
