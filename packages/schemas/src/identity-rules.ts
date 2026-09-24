import { z } from 'zod';
import type { ContactIdentityKind } from './contact.js';

/**
 * DOMAIN-RULES §4.4's table, as data (M1-13).
 *
 * | Identifier | Verified when |
 * |---|---|
 * | Email | an inbound email arrived from it, or a magic link sent to it was clicked |
 * | Telegram `chat_id` | always (it comes from the Bot API) |
 * | Signed `external_id` | always (HMAC) |
 * | Phone | never in v1 |
 * | Email typed in a form | never |
 *
 * A caller does not say whether an identifier is verified; it says **where the
 * identifier came from**, and this table answers. That keeps "is this proof?"
 * in one reviewed place instead of a boolean every channel adapter passes and
 * any of them could get wrong.
 *
 * The widget's own visitor id is verified too: the server issued it and holds
 * the hash of its secret (§4.1), which is the same kind of proof as a Bot API
 * chat id.
 */
export const identitySourceSchema = z.enum([
  /** The `From:` of an inbound email (M2). */
  'email.inbound',
  /** A magic link sent to the address was clicked (M4). */
  'email.magic_link',
  /** An address on the `Cc:` line of an inbound email, or added as a CC by an agent. */
  'email.cc',
  /** The chat id of a Telegram update (M6). */
  'telegram.bot',
  /** The `user_id` of a valid signed identity (§4.2). */
  'widget.signed',
  /** The visitor id the widget was issued on first load (§4.1). */
  'widget.visitor',
  /** Anything typed into a widget pre-chat form. */
  'widget.form',
  /** Typed by an agent on the contact screens. */
  'agent',
  /** A bulk import. */
  'import',
]);
export type IdentitySource = z.infer<typeof identitySourceSchema>;

interface SourceRule {
  /** The identifier kinds this source can produce. Anything else is a caller's bug. */
  readonly kinds: readonly ContactIdentityKind[];
  readonly verified: boolean;
}

const ALL_KINDS: readonly ContactIdentityKind[] = [
  'email',
  'phone',
  'telegram',
  'visitor',
  'external',
];

export const IDENTITY_SOURCE_RULES: Readonly<Record<IdentitySource, SourceRule>> = Object.freeze({
  'email.inbound': { kinds: ['email'], verified: true },
  'email.magic_link': { kinds: ['email'], verified: true },
  // Somebody else's mail client wrote that address; nothing proves its owner
  // took part.
  'email.cc': { kinds: ['email'], verified: false },
  'telegram.bot': { kinds: ['telegram'], verified: true },
  'widget.signed': { kinds: ['external'], verified: true },
  'widget.visitor': { kinds: ['visitor'], verified: true },
  'widget.form': { kinds: ['email', 'phone'], verified: false },
  agent: { kinds: ALL_KINDS, verified: false },
  import: { kinds: ALL_KINDS, verified: false },
});

/**
 * Whether an identifier of `kind` that arrived through `source` is verified.
 *
 * A kind the source cannot produce — a phone number "from the Bot API" —
 * throws a `TypeError`: no request body reaches this, so it is a mistake at the
 * call site rather than a refusal anybody should be shown.
 */
export const isVerifiedIdentity = (kind: ContactIdentityKind, source: IdentitySource): boolean => {
  const rule = IDENTITY_SOURCE_RULES[source];
  if (!rule.kinds.includes(kind)) {
    throw new TypeError(`An identifier from ${source} cannot be of kind ${kind}`);
  }

  return rule.verified;
};
