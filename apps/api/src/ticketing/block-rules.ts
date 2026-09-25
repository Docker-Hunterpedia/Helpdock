import type { BlockedSenderKind } from '@helpdock/schemas';
import { domainAndParents, domainCovers, domainOfAddress } from '@helpdock/schemas';

/**
 * The block list's rules as pure functions of values the caller has already
 * read (M1-11), apart from the service for the reason `status-rules.ts` gives:
 * they are what a reviewer wants to read beside DOMAIN-RULES, and a rule that
 * needs a database to be tested gets tested once.
 */

/** What a brand sends from, normalised: lower-case addresses and domains. */
export interface OwnSenders {
  readonly addresses: readonly string[];
  readonly domains: readonly string[];
}

/** One `(kind, value)` pair, both normalised. */
export interface SenderKey {
  readonly kind: BlockedSenderKind;
  readonly value: string;
}

/**
 * Whether blocking this would drop the brand's own mail — "A brand cannot
 * block a domain it sends from".
 *
 * | Kind | Refused when |
 * |---|---|
 * | `email` | it is an own address, or its domain is an own domain or below one |
 * | `domain` | it is an own domain, a parent of one, or below one |
 * | `phone`, `telegram` | never: no brand sends from either in v1 |
 *
 * A domain *below* an own domain is refused as well as a parent: blocking
 * `mail.acme.com` when the brand sends from `acme.com` blocks the brand's own
 * infrastructure, which is never what an agent marking a spam ticket meant.
 */
export const isOwnSender = ({ kind, value }: SenderKey, own: OwnSenders): boolean => {
  switch (kind) {
    case 'email': {
      const domain = domainOfAddress(value);
      return (
        own.addresses.includes(value) || own.domains.some((mine) => domainCovers(mine, domain))
      );
    }
    case 'domain':
      return own.domains.some((mine) => domainCovers(value, mine) || domainCovers(mine, value));
    case 'phone':
    case 'telegram':
      return false;
  }
};

/**
 * Every block-list row that would stop a message from this sender, most
 * specific first: the exact identifier, then — for an address — its domain and
 * each parent of it. The gate looks all of them up in one statement on the
 * unique index and charges the drop to the first that exists.
 */
export const matchKeysFor = (sender: SenderKey): readonly SenderKey[] => {
  if (sender.kind !== 'email') {
    return [sender];
  }

  return [
    sender,
    ...domainAndParents(domainOfAddress(sender.value)).map(
      (value): SenderKey => ({ kind: 'domain', value }),
    ),
  ];
};

/** The first of `keys` that `found` holds, which is the most specific match. */
export const mostSpecific = <T extends SenderKey>(
  keys: readonly SenderKey[],
  found: readonly T[],
): T | undefined => {
  for (const key of keys) {
    const hit = found.find((row) => row.kind === key.kind && row.value === key.value);
    if (hit !== undefined) {
      return hit;
    }
  }

  return undefined;
};
