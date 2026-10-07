import { describe, expect, it } from 'vitest';
import { messageIdDomain, outboundMessageId } from './message-id.js';

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
