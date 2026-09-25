import { describe, expect, it } from 'vitest';
import {
  CSAT_COMMENT_MAX,
  csatSubmitRequestSchema,
  csatSurveyViewSchema,
  csatTokenParamSchema,
} from './csat.js';

const TOKEN = `${'A'.repeat(43)}.${'b'.repeat(43)}`;
const BRAND = { name: 'Helpdock', locale: 'en', accent: null } as const;

describe('csatTokenParamSchema', () => {
  it('takes the two base64url halves a link carries', () => {
    expect(csatTokenParamSchema.safeParse({ token: TOKEN }).success).toBe(true);
  });

  it.each([
    ['a truncated token', TOKEN.slice(0, -1)],
    ['padding', `${'A'.repeat(42)}=.${'b'.repeat(43)}`],
    ['a path segment', `${'A'.repeat(43)}/${'b'.repeat(43)}`],
  ])('refuses %s before anything is computed', (_label, token) => {
    expect(csatTokenParamSchema.safeParse({ token }).success).toBe(false);
  });
});

describe('csatSubmitRequestSchema', () => {
  it.each([0, 6, 3.5])('refuses a rating of %s', (rating) => {
    expect(csatSubmitRequestSchema.safeParse({ rating }).success).toBe(false);
  });

  it('trims the comment', () => {
    expect(csatSubmitRequestSchema.parse({ rating: 5, comment: '  Kind.  ' })).toEqual({
      rating: 5,
      comment: 'Kind.',
    });
  });

  it('caps the comment', () => {
    expect(
      csatSubmitRequestSchema.safeParse({ rating: 5, comment: 'x'.repeat(CSAT_COMMENT_MAX + 1) })
        .success,
    ).toBe(false);
  });
});

describe('csatSurveyViewSchema', () => {
  it('strips the ticket from a spent link, so it cannot leak the subject', () => {
    const parsed = csatSurveyViewSchema.parse({
      state: 'used',
      brand: BRAND,
      ticket: { reference: 'HD-1042', subject: 'Refund not received' },
    });

    expect(parsed).toEqual({ state: 'used', brand: BRAND });
  });

  it('refuses a brand accent that is not a six-digit hex colour', () => {
    expect(
      csatSurveyViewSchema.safeParse({ state: 'expired', brand: { ...BRAND, accent: 'teal' } })
        .success,
    ).toBe(false);
  });
});
