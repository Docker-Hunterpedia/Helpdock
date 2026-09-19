import type {
  Account as AccountRow,
  ContactDuplicateSuggestion as ContactDuplicateSuggestionRow,
  ContactIdentity as ContactIdentityRow,
  ContactNote as ContactNoteRow,
  Contact as ContactRow,
  User,
} from '@helpdock/db';
import type {
  Account,
  ContactDuplicateSuggestion,
  ContactIdentity,
  ContactIdentityKind,
  ContactNote,
  ContactStats,
  ContactSummary,
} from '@helpdock/schemas';
import { EMPTY_CONTACT_STATS } from './providers.js';

/**
 * Rows to the shapes `@helpdock/schemas` declares. Kept apart from the service
 * so that "what the client is shown" can be read and tested without a database
 * — and so a column a later milestone adds cannot reach a response by being on
 * the row.
 */

/** DESIGN §6.2: the channel icons, always in one order whatever the rows say. */
const KIND_ORDER: readonly ContactIdentityKind[] = [
  'email',
  'phone',
  'telegram',
  'visitor',
  'external',
];

export const identityView = (row: ContactIdentityRow): ContactIdentity => ({
  id: row.id,
  kind: row.kind,
  value: row.value,
  verified: row.verified,
  verifiedAt: row.verifiedAt?.toISOString() ?? null,
  source: row.source,
});

/**
 * The identifier a row is headed by: a verified email first, then any verified
 * identifier, then whatever there is. An anonymous visitor has only a visitor
 * id, and that is what the row shows — which is how the "anonymous" style on
 * the artboard knows it is one.
 */
export const primaryIdentityOf = (
  identities: readonly ContactIdentityRow[],
): ContactIdentityRow | null => {
  const verifiedEmail = identities.find((row) => row.kind === 'email' && row.verified);
  const anyVerified = identities.find((row) => row.verified);
  const anyEmail = identities.find((row) => row.kind === 'email');

  return verifiedEmail ?? anyVerified ?? anyEmail ?? identities[0] ?? null;
};

export const channelsOf = (identities: readonly ContactIdentityRow[]): ContactIdentityKind[] => {
  const held = new Set(identities.map((row) => row.kind));

  return KIND_ORDER.filter((kind) => held.has(kind));
};

export const accountView = (row: AccountRow, contactCount: number): Account => ({
  id: row.id,
  name: row.name,
  domain: row.domain,
  custom: row.custom,
  contactCount,
  createdAt: row.createdAt.toISOString(),
});

export const noteView = (row: ContactNoteRow, author: User | null): ContactNote => ({
  id: row.id,
  bodyText: row.bodyText,
  authorId: row.authorId,
  // A note written by somebody whose account has since been deleted keeps its
  // author id; the name is whatever `users` says now, which is "Former staff".
  authorName: author?.name ?? 'Former staff',
  createdAt: row.createdAt.toISOString(),
});

export const summaryView = (
  contact: ContactRow,
  {
    identities,
    account,
    stats,
  }: {
    readonly identities: readonly ContactIdentityRow[];
    readonly account: AccountRow | undefined;
    readonly stats: ContactStats | undefined;
  },
): ContactSummary => {
  const primary = primaryIdentityOf(identities);

  return {
    id: contact.id,
    name: contact.name,
    account: account === undefined ? null : { id: account.id, name: account.name },
    primaryIdentity: primary === null ? null : identityView(primary),
    channels: channelsOf(identities),
    stats: stats ?? EMPTY_CONTACT_STATS,
    anonymised: contact.anonymisedAt !== null,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
};

export const duplicateView = (
  suggestion: ContactDuplicateSuggestionRow,
  {
    other,
    otherIdentities,
    otherAccount,
    sameAccount,
  }: {
    readonly other: ContactRow;
    readonly otherIdentities: readonly ContactIdentityRow[];
    readonly otherAccount: AccountRow | undefined;
    readonly sameAccount: boolean;
  },
): ContactDuplicateSuggestion => {
  const primary = primaryIdentityOf(otherIdentities);

  return {
    id: suggestion.id,
    reason: suggestion.reason,
    other: {
      id: other.id,
      name: other.name,
      primaryIdentity: primary === null ? null : identityView(primary),
      accountName: otherAccount?.name ?? null,
    },
    sameAccount,
    createdAt: suggestion.createdAt.toISOString(),
  };
};

/** Groups a flat list of identity rows by the contact they belong to. */
export const byContact = <T extends { readonly contactId: string }>(
  rows: readonly T[],
): ReadonlyMap<string, T[]> => {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const bucket = grouped.get(row.contactId);
    if (bucket === undefined) {
      grouped.set(row.contactId, [row]);
    } else {
      bucket.push(row);
    }
  }

  return grouped;
};
