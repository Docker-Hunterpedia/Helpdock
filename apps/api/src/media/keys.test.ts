import { describe, expect, it } from 'vitest';
import { attachmentKey, attachmentPrefix } from './keys.js';

const BRAND = '01937f5e-7e53-7000-8000-00000000000a';
const TICKET = '01937f5e-7e53-7000-8000-00000000000b';
const ATTACHMENT = '01937f5e-7e53-7000-8000-00000000000c';

const parts = { brandId: BRAND, ticketId: TICKET, attachmentId: ATTACHMENT };

describe('attachmentKey', () => {
  it('lays objects out brand, then ticket, then attachment, then variant', () => {
    expect(attachmentKey(parts, 'original')).toBe(
      `brands/${BRAND}/tickets/${TICKET}/${ATTACHMENT}/original`,
    );
    expect(attachmentKey(parts, 'thumb320')).toBe(
      `brands/${BRAND}/tickets/${TICKET}/${ATTACHMENT}/thumb320`,
    );
  });

  it('puts every object of one attachment under one prefix', () => {
    for (const variant of ['original', 'webp', 'thumb320', 'thumb960'] as const) {
      expect(attachmentKey(parts, variant).startsWith(attachmentPrefix(parts))).toBe(true);
    }
  });

  it('nests under the brand and the ticket, which is what makes a purge one prefix', () => {
    // DOMAIN-RULES §11 deletes a brand by purging "every row, S3 prefix, Redis
    // key and Caddy domain", and retention deletes a closed ticket's
    // attachments. Both are one `ListObjectsV2` only because of this ordering.
    expect(attachmentPrefix(parts).startsWith(`brands/${BRAND}/`)).toBe(true);
    expect(attachmentPrefix(parts).startsWith(`brands/${BRAND}/tickets/${TICKET}/`)).toBe(true);
  });

  it('lower-cases a uuid, so one attachment can never own two prefixes', () => {
    expect(attachmentKey({ ...parts, brandId: BRAND.toUpperCase() }, 'original')).toBe(
      attachmentKey(parts, 'original'),
    );
  });

  it('refuses a segment that is not a uuid, whatever it is', () => {
    // Nothing a caller typed ever reaches a key — every segment is a uuid this
    // api generated — so this is the assertion that keeps it that way.
    for (const bad of ['../../etc', 'not-a-uuid', '', `${BRAND}/x`, `${BRAND}%2f..`]) {
      expect(() => attachmentKey({ ...parts, ticketId: bad }, 'original'), bad).toThrow(TypeError);
    }
    expect(() => attachmentPrefix({ ...parts, brandId: '..' })).toThrow(TypeError);
    expect(() => attachmentPrefix({ ...parts, attachmentId: '..' })).toThrow(TypeError);
  });
});
