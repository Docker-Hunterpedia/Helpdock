import { z } from 'zod';
import {
  MAX_IDENTITY_LENGTH,
  type NormaliseOptions,
  type NormaliseResult,
  normaliseEmail,
  normalisePhone,
  normaliseTelegram,
} from './contact.js';

/**
 * Spam (M1-11): the sender block list, the "Mark as spam" request, and the one
 * normaliser every writer and every reader of the block list goes through.
 *
 * Three of the four kinds are contact identifier kinds and are normalised by
 * the very functions `contact_identities` is (ADR 0008 for phone numbers), so
 * the value an inbound channel already normalised for the contact is the value
 * the gate compares. The fourth, `domain`, is new here.
 */

// --------------------------------------------------------------------------
// What being spam means (DOMAIN-RULES §2.2)
// --------------------------------------------------------------------------

/**
 * Whether a ticket in this status is spam. The one question every consumer
 * asks — M1-07's round-robin counts, M1-12's survey, M2's auto-responder, M3's
 * reports — asked of the flag and never of the name, because a brand may
 * rename Spam.
 *
 * | Consumer | What spam means to it |
 * |---|---|
 * | auto-responder (M2) | send nothing |
 * | CSAT (M1-12) | schedule nothing — the lifecycle already withholds `onClosedForCsat` |
 * | round-robin and load caps (M1-07) | the ticket does not count against anybody |
 * | reports (M3) | left out, through `countsInReports` |
 */
export const isSpamStatus = (status: { readonly isSpam: boolean }): boolean => status.isSpam;

/**
 * Whether a ticket in this status belongs in a report or a count: false for
 * Spam and for Merged (DOMAIN-RULES §2.1, §2.4). Wider than
 * {@link isSpamStatus} on purpose — a merged secondary is not a second
 * resolution either.
 */
export const countsInReports = (status: { readonly excludedFromReports: boolean }): boolean =>
  !status.excludedFromReports;

// --------------------------------------------------------------------------
// The block list
// --------------------------------------------------------------------------

export const blockedSenderKindSchema = z.enum(['email', 'domain', 'phone', 'telegram']);
export type BlockedSenderKind = z.infer<typeof blockedSenderKindSchema>;

/** 253 characters is the maximum length of a DNS name in presentation form. */
const MAX_DOMAIN_LENGTH = 253;
/** The rule `domain-check.ts` holds a hostname to: lower-case A-labels, two or more. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
/** Anything that would make `http://<value>` more than a host. */
const NOT_A_HOST = /[\s/?#:@\\]/u;

/** A contact identifier's refusal, or the one refusal only a domain has. */
export type BlockedSenderNormaliseResult =
  | NormaliseResult
  | { readonly ok: false; readonly problem: 'invalid-domain' };

/**
 * A domain as the block list stores it: trimmed, lower-cased, no leading `@`
 * (people type `@promo-deals.biz`), no trailing dot, and punycode for a
 * non-ASCII label — which is what an email header carries, so `bücher.de`
 * typed by an Admin matches mail from `xn--bcher-kva.de`.
 */
export const normaliseDomain = (raw: string): BlockedSenderNormaliseResult => {
  const trimmed = raw.trim().replace(/^@/, '').replace(/\.$/, '');
  if (trimmed === '') {
    return { ok: false, problem: 'empty' };
  }
  if (trimmed.length > MAX_DOMAIN_LENGTH) {
    return { ok: false, problem: 'too-long' };
  }
  if (NOT_A_HOST.test(trimmed)) {
    return { ok: false, problem: 'invalid-domain' };
  }

  let host: string;
  try {
    host = new URL(`http://${trimmed}`).hostname;
  } catch {
    return { ok: false, problem: 'invalid-domain' };
  }

  return DOMAIN.test(host) ? { ok: true, value: host } : { ok: false, problem: 'invalid-domain' };
};

/** The one entry point: what a block-list row of this kind stores for this input. */
export const normaliseBlockedSender = (
  kind: BlockedSenderKind,
  value: string,
  options: NormaliseOptions = {},
): BlockedSenderNormaliseResult => {
  switch (kind) {
    case 'email':
      return normaliseEmail(value);
    case 'domain':
      return normaliseDomain(value);
    case 'phone':
      return normalisePhone(value, options);
    case 'telegram':
      return normaliseTelegram(value);
  }
};

/** The part of a normalised address after the last `@`. */
export const domainOfAddress = (address: string): string =>
  address.slice(address.lastIndexOf('@') + 1);

/**
 * Whether a block on `blocked` reaches mail from `domain`: the domain itself
 * and every subdomain of it, so blocking `promo-deals.biz` also drops
 * `news.promo-deals.biz`. Never the other way: blocking a subdomain says
 * nothing about its parent.
 */
export const domainCovers = (blocked: string, domain: string): boolean =>
  domain === blocked || domain.endsWith(`.${blocked}`);

/**
 * Every domain a block could be written against for mail from `domain`: the
 * domain and each parent with at least two labels. `a.b.example.com` yields
 * `a.b.example.com`, `b.example.com`, `example.com`. The gate asks for exactly
 * these, so the lookup is an equality on the unique index rather than a scan.
 */
export const domainAndParents = (domain: string): string[] => {
  const labels = domain.split('.');
  const out: string[] = [];
  for (let start = 0; start <= labels.length - 2; start += 1) {
    out.push(labels.slice(start).join('.'));
  }

  return out;
};

// --------------------------------------------------------------------------
// The wire shapes
// --------------------------------------------------------------------------

/** One row of the Spam tab's block list. */
export const blockedSenderSchema = z.object({
  id: z.uuid(),
  kind: blockedSenderKindSchema,
  value: z.string().min(1),
  /** Null when the person who added it has since been deleted (DOMAIN-RULES §12). */
  createdByName: z.string().nullable(),
  /** The ticket "Mark as spam" blocked it from, when that is how it was added. */
  sourceTicketId: z.uuid().nullable(),
  /** How many inbound messages this row has stopped before they became tickets. */
  droppedCount: z.int().nonnegative(),
  lastDroppedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type BlockedSender = z.infer<typeof blockedSenderSchema>;

export const blockedSenderListSchema = z.object({ senders: z.array(blockedSenderSchema) });
export type BlockedSenderList = z.infer<typeof blockedSenderListSchema>;

/**
 * "Block a sender". The value is normalised by the api rather than here,
 * because a phone number needs the brand's default calling code (ADR 0008)
 * and a schema has no brand.
 */
export const blockedSenderCreateRequestSchema = z.object({
  kind: blockedSenderKindSchema,
  value: z.string().trim().min(1).max(MAX_IDENTITY_LENGTH),
});
export type BlockedSenderCreateRequest = z.infer<typeof blockedSenderCreateRequestSchema>;

export const blockedSenderParamSchema = z.object({
  brandId: z.uuid(),
  blockedSenderId: z.uuid(),
});
export type BlockedSenderParam = z.infer<typeof blockedSenderParamSchema>;

/** The Spam tab's settings card: one toggle, `ticketing:manage`. */
export const spamSettingsUpdateRequestSchema = z.object({ offerBlockSender: z.boolean() });
export type SpamSettingsUpdateRequest = z.infer<typeof spamSettingsUpdateRequestSchema>;

/** "Mark as spam", with the one choice its dialog offers. */
export const markSpamRequestSchema = z.object({ blockSender: z.boolean().default(false) });
export type MarkSpamRequest = z.infer<typeof markSpamRequestSchema>;

/** Who a ticket is from, in block-list terms. */
export const spamSenderIdentitySchema = z.object({
  kind: blockedSenderKindSchema,
  value: z.string().min(1),
});
export type SpamSenderIdentity = z.infer<typeof spamSenderIdentitySchema>;

/**
 * What the "Mark as spam" dialog reads before it opens: whether to draw the
 * "Block sender" checkbox, and what to name in it.
 *
 * The api decides all three, because two of them need data the workspace does
 * not hold — the brand's own sending domains, and the block list itself.
 */
export const ticketSpamSenderSchema = z.object({
  /** Null when the ticket has no contact, or none of its identifiers can be blocked. */
  sender: spamSenderIdentitySchema.nullable(),
  /** The brand setting "Offer 'Block sender' when marking as spam". */
  offered: z.boolean(),
  /** False when the sender is one of the brand's own addresses or domains. */
  blockable: z.boolean(),
  /** Already on the block list, so the checkbox would change nothing. */
  blocked: z.boolean(),
});
export type TicketSpamSender = z.infer<typeof ticketSpamSenderSchema>;
