import { metaIdentityValue } from '@helpdock/channels';
import type { MetaPlatform } from '@helpdock/schemas';
import { describe, expect, it } from 'vitest';
import { senderOf } from '../tickets/spam-sender.js';
import { metaBlockEntry } from './meta-inbound-gate.js';

/**
 * "Block sender" on a Meta ticket and the inbound gate must name the same
 * customer: the first blocks what `senderOf` finds in the contact's identities,
 * the second looks up `metaBlockEntry`. This pins that they agree for each
 * platform without faking either side; the drop itself, from the ticket's Block
 * sender route to the next webhook, is `meta.integration.test.ts`.
 */

describe('metaBlockEntry', () => {
  it.each([
    ['whatsapp', '106540352242922', 'US.13491208655302741918', 'US.13491208655302741918'],
    ['messenger', '112233445566778', '7654321098765432', '112233445566778:7654321098765432'],
    ['instagram', '17841400000000000', '17841499999999999', '17841400000000000:17841499999999999'],
  ] as const)(
    'is what Block sender blocks on a %s ticket: the value the contact’s identity has',
    (platform: MetaPlatform, account, customer, value) => {
      // The identities the inbound router gives the contact it makes (DOMAIN-RULES §4.7), newest last.
      const identities = [
        { kind: platform, value: metaIdentityValue(platform, account, customer) },
        { kind: 'phone' as const, value: '+16505550123' },
      ].map((identity, index) => ({ ...identity, createdAt: new Date(1_760_000_000_000 + index) }));

      expect(metaBlockEntry({ platform, externalId: account }, customer)).toEqual({
        kind: platform,
        value,
      });
      expect(senderOf(platform, identities)).toEqual(
        metaBlockEntry({ platform, externalId: account }, customer),
      );
    },
  );

  it('keeps one customer apart from the same id under another account', () => {
    const one = metaBlockEntry({ platform: 'messenger', externalId: '111' }, '777');
    const other = metaBlockEntry({ platform: 'messenger', externalId: '222' }, '777');

    expect(one.value).not.toBe(other.value);
  });
});
