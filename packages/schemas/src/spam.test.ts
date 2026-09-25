import { describe, expect, it } from 'vitest';
import {
  blockedSenderCreateRequestSchema,
  countsInReports,
  domainAndParents,
  domainCovers,
  domainOfAddress,
  isSpamStatus,
  markSpamRequestSchema,
  normaliseBlockedSender,
  normaliseDomain,
} from './spam.js';

describe('isSpamStatus and countsInReports', () => {
  it('reads spam off the flag, so a renamed Spam status is still spam', () => {
    expect(isSpamStatus({ isSpam: true })).toBe(true);
    expect(isSpamStatus({ isSpam: false })).toBe(false);
  });

  it('leaves every status excluded from reports out of a count, Merged included', () => {
    expect(countsInReports({ excludedFromReports: true })).toBe(false);
    expect(countsInReports({ excludedFromReports: false })).toBe(true);
  });
});

describe('normaliseDomain', () => {
  it.each([
    ['Promo-Deals.BIZ', 'promo-deals.biz'],
    ['  @promo-deals.biz ', 'promo-deals.biz'],
    ['promo-deals.biz.', 'promo-deals.biz'],
    ['bücher.de', 'xn--bcher-kva.de'],
  ])('stores %j as %j', (raw, stored) => {
    expect(normaliseDomain(raw)).toEqual({ ok: true, value: stored });
  });

  it.each([
    ['', 'empty'],
    ['localhost', 'invalid-domain'],
    ['promo deals.biz', 'invalid-domain'],
    ['spam@promo-deals.biz', 'invalid-domain'],
    ['promo-deals.biz/path', 'invalid-domain'],
    ['promo-deals.biz:25', 'invalid-domain'],
    ['-promo.biz', 'invalid-domain'],
    ['[::1]', 'invalid-domain'],
    [`${'a'.repeat(250)}.biz`, 'too-long'],
  ])('refuses %j with %s', (raw, problem) => {
    expect(normaliseDomain(raw)).toEqual({ ok: false, problem });
  });
});

describe('normaliseBlockedSender', () => {
  it('normalises an address the way a contact identity is normalised', () => {
    expect(normaliseBlockedSender('email', ' Spam@Promo-Deals.biz ')).toEqual({
      ok: true,
      value: 'spam@promo-deals.biz',
    });
  });

  it('normalises a phone number by ADR 0008, calling code and all', () => {
    expect(normaliseBlockedSender('phone', '+1 555 0100 123')).toEqual({
      ok: true,
      value: '+15550100123',
    });
    expect(normaliseBlockedSender('phone', '0931 234 567', { defaultCallingCode: '963' })).toEqual({
      ok: true,
      value: '+963931234567',
    });
    expect(normaliseBlockedSender('phone', '0931 234 567')).toEqual({
      ok: false,
      problem: 'phone-not-international',
    });
  });

  it('takes a Telegram chat id as the digits the Bot API gives', () => {
    expect(normaliseBlockedSender('telegram', ' 123456789 ')).toEqual({
      ok: true,
      value: '123456789',
    });
    expect(normaliseBlockedSender('telegram', '@crypto_bot_9')).toEqual({
      ok: false,
      problem: 'invalid-telegram',
    });
  });

  it('routes a domain to the domain rule', () => {
    expect(normaliseBlockedSender('domain', 'PROMO.biz')).toEqual({ ok: true, value: 'promo.biz' });
  });
});

describe('domain matching', () => {
  it('reads the domain after the last @', () => {
    expect(domainOfAddress('spam@promo-deals.biz')).toBe('promo-deals.biz');
  });

  it('covers the domain itself and every subdomain, never the parent', () => {
    expect(domainCovers('promo-deals.biz', 'promo-deals.biz')).toBe(true);
    expect(domainCovers('promo-deals.biz', 'news.promo-deals.biz')).toBe(true);
    expect(domainCovers('news.promo-deals.biz', 'promo-deals.biz')).toBe(false);
    // A suffix that is not a label boundary is a different domain.
    expect(domainCovers('deals.biz', 'promo-deals.biz')).toBe(false);
  });

  it('lists the domain and each parent of two labels or more', () => {
    expect(domainAndParents('a.b.example.com')).toEqual([
      'a.b.example.com',
      'b.example.com',
      'example.com',
    ]);
    expect(domainAndParents('example.com')).toEqual(['example.com']);
  });
});

describe('request schemas', () => {
  it('refuses a kind the block list has no column for', () => {
    expect(
      blockedSenderCreateRequestSchema.safeParse({ kind: 'visitor', value: 'x' }).success,
    ).toBe(false);
  });

  it('trims the value and refuses an empty one', () => {
    expect(blockedSenderCreateRequestSchema.parse({ kind: 'domain', value: ' a.biz ' }).value).toBe(
      'a.biz',
    );
    expect(
      blockedSenderCreateRequestSchema.safeParse({ kind: 'domain', value: '  ' }).success,
    ).toBe(false);
  });

  it('marks as spam without blocking unless the dialog said so', () => {
    expect(markSpamRequestSchema.parse({})).toEqual({ blockSender: false });
  });
});
