import { describe, expect, it } from 'vitest';
import { isOwnSender, matchKeysFor, mostSpecific, type OwnSenders } from './block-rules.js';

const OWN: OwnSenders = {
  addresses: ['support@helpdock.com'],
  domains: ['helpdock.com', 'help.acme.test'],
};

describe('isOwnSender', () => {
  it.each([
    ['the sending address itself', 'email', 'support@helpdock.com'],
    ['a colleague at the sending domain', 'email', 'lina@helpdock.com'],
    ['an address below the sending domain', 'email', 'bounce@mail.helpdock.com'],
    ['the sending domain', 'domain', 'helpdock.com'],
    ['a parent of a brand hostname', 'domain', 'acme.test'],
    ['a domain below the sending domain', 'domain', 'mail.helpdock.com'],
  ] as const)('refuses %s', (_label, kind, value) => {
    expect(isOwnSender({ kind, value }, OWN)).toBe(true);
  });

  it.each([
    ['a stranger’s address', 'email', 'spam@promo-deals.biz'],
    ['a domain that only ends in the same letters', 'domain', 'fakehelpdock.com'],
    ['a sibling of a brand hostname', 'domain', 'shop.acme.test'],
    ['a phone number', 'phone', '+15550100123'],
    ['a Telegram chat', 'telegram', '123456789'],
  ] as const)('allows %s', (_label, kind, value) => {
    expect(isOwnSender({ kind, value }, OWN)).toBe(false);
  });

  it('allows everything when the brand sends from nowhere yet', () => {
    expect(
      isOwnSender({ kind: 'domain', value: 'helpdock.com' }, { addresses: [], domains: [] }),
    ).toBe(false);
  });
});

describe('matchKeysFor', () => {
  it('asks about an address, then its domain, then each parent', () => {
    expect(matchKeysFor({ kind: 'email', value: 'x@news.promo-deals.biz' })).toEqual([
      { kind: 'email', value: 'x@news.promo-deals.biz' },
      { kind: 'domain', value: 'news.promo-deals.biz' },
      { kind: 'domain', value: 'promo-deals.biz' },
    ]);
  });

  it('asks about a phone number or a chat exactly as given', () => {
    expect(matchKeysFor({ kind: 'phone', value: '+15550100123' })).toEqual([
      { kind: 'phone', value: '+15550100123' },
    ]);
  });
});

describe('mostSpecific', () => {
  const keys = matchKeysFor({ kind: 'email', value: 'x@news.promo-deals.biz' });

  it('prefers the address to its domain, whatever order the rows came back in', () => {
    const found = [
      { id: 'domain', kind: 'domain' as const, value: 'promo-deals.biz' },
      { id: 'address', kind: 'email' as const, value: 'x@news.promo-deals.biz' },
    ];

    expect(mostSpecific(keys, found)?.id).toBe('address');
  });

  it('prefers a subdomain to its parent', () => {
    const found = [
      { id: 'parent', kind: 'domain' as const, value: 'promo-deals.biz' },
      { id: 'child', kind: 'domain' as const, value: 'news.promo-deals.biz' },
    ];

    expect(mostSpecific(keys, found)?.id).toBe('child');
  });

  it('answers undefined when nothing matched', () => {
    expect(mostSpecific(keys, [])).toBeUndefined();
  });
});
