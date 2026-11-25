import {
  accounts,
  brands,
  contactIdentities,
  contacts,
  customerSessions,
  customerSignInTokens,
  type Db,
  type DbTransaction,
  systemContext,
  withTenant,
} from '@helpdock/db';
import { type PortalSettings, parseBrandSettings } from '@helpdock/schemas';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { attachVerifiedIdentity, findOrCreateContactByIdentity } from '../contacts/identity.js';
import { isUniqueViolation } from '../http/unique-violation.js';
import type { CustomerScope } from './customer-context.js';
import { hashToken, isExpired, sameHash, sessionExpiry, shouldTouch } from './session-rules.js';

/**
 * Everything the sign-in flow reads and writes in `customer_sessions`,
 * `customer_sign_in_tokens` and the contact tables. Every function here runs on
 * the explicit system path: the row-level-security policies of M21-01 let only
 * that path write the two portal tables, and the sign-in link is spent and a
 * session made before there is a customer to be.
 */

const JOB_ID = 'portal:sign-in';

/** Runs `fn` as the audited system principal of one brand. */
export const asSystem = <T>(
  db: Db,
  brandId: string,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> => withTenant(db, systemContext(brandId, JOB_ID), fn);

/** The brand's portal settings, or null when it is not active or has the portal off. */
export const readPortalSettings = async (
  tx: DbTransaction,
  brandId: string,
): Promise<PortalSettings | null> => {
  const [brand] = await tx
    .select({ settings: brands.settings, status: brands.status, deletedAt: brands.deletedAt })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (brand === undefined || brand.status !== 'active' || brand.deletedAt !== null) {
    return null;
  }
  const portal = parseBrandSettings(brand.settings).portal;
  return portal.enabled ? portal : null;
};

export interface EmailOwner {
  readonly contactId: string;
  readonly identityId: string;
}

/**
 * The live contact of this brand that has `email` as an email identity, verified
 * or not. A contact merged away or anonymised never counts.
 */
export const findEmailOwner = async (
  tx: DbTransaction,
  brandId: string,
  email: string,
): Promise<EmailOwner | null> => {
  const [row] = await tx
    .select({ contactId: contacts.id, identityId: contactIdentities.id })
    .from(contactIdentities)
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(
      and(
        eq(contactIdentities.brandId, brandId),
        eq(contactIdentities.kind, 'email'),
        eq(contactIdentities.value, email),
        isNull(contacts.mergedIntoId),
        isNull(contacts.anonymisedAt),
      ),
    )
    .limit(1);
  return row ?? null;
};

/** Whether any contact, live or not, holds this address: a merged or erased holder blocks a link even for new customers. */
export const emailIsHeld = async (
  tx: DbTransaction,
  brandId: string,
  email: string,
): Promise<boolean> => {
  const [row] = await tx
    .select({ id: contactIdentities.id })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.brandId, brandId),
        eq(contactIdentities.kind, 'email'),
        eq(contactIdentities.value, email),
      ),
    )
    .limit(1);
  return row !== undefined;
};

export const insertSignInToken = async (
  tx: DbTransaction,
  input: {
    readonly brandId: string;
    readonly email: string;
    readonly contactId: string | null;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  },
): Promise<void> => {
  await tx.insert(customerSignInTokens).values(input);
};

export type TokenState =
  | {
      readonly state: 'live';
      readonly id: string;
      readonly email: string;
      readonly contactId: string | null;
    }
  | { readonly state: 'expired' }
  | { readonly state: 'used' };

/**
 * What a link is, without spending it. An unknown token and a token of another
 * brand are both `expired`: the page says nothing about which.
 */
export const readSignInToken = async (
  tx: DbTransaction,
  brandId: string,
  token: string,
  now: Date,
): Promise<TokenState> => {
  const hash = hashToken(token);
  const [row] = await tx
    .select()
    .from(customerSignInTokens)
    .where(and(eq(customerSignInTokens.tokenHash, hash), eq(customerSignInTokens.brandId, brandId)))
    .limit(1);
  if (row === undefined || !sameHash(row.tokenHash, hash)) {
    return { state: 'expired' };
  }
  if (row.spentAt !== null) {
    return { state: 'used' };
  }
  if (isExpired(row.expiresAt, now)) {
    return { state: 'expired' };
  }
  return { state: 'live', id: row.id, email: row.email, contactId: row.contactId };
};

/** Marks the link spent if nobody else did first; false means somebody did. */
export const spendSignInToken = async (
  tx: DbTransaction,
  id: string,
  now: Date,
): Promise<boolean> => {
  const spent = await tx
    .update(customerSignInTokens)
    .set({ spentAt: now })
    .where(
      and(
        eq(customerSignInTokens.id, id),
        isNull(customerSignInTokens.spentAt),
        gt(customerSignInTokens.expiresAt, now),
      ),
    )
    .returning({ id: customerSignInTokens.id });
  return spent.length === 1;
};

const portalClaim = (email: string) =>
  ({ kind: 'email', value: email, source: 'portal.sign_in' }) as const;

/**
 * Who the spent link signs in, through the contact seam (`contacts/identity.ts`).
 * A live holder of the address, verified or not, is the contact; the seam marks
 * the identity verified (`portal.sign_in` is a verified source). With no holder
 * and `create` set, the seam creates the contact with the address as a verified
 * identity. An address held by a merged or erased contact is nobody's to sign
 * in, so it is refused rather than given a second contact.
 *
 * A contact made by somebody else between the check and the insert (an inbound
 * mail, say) raises the unique index; the attempt runs in a savepoint, so the
 * caller's transaction stays usable and the holder is read again and used.
 */
export const resolveSigner = async (
  tx: DbTransaction,
  brandId: string,
  email: string,
  options: { readonly create: boolean },
): Promise<EmailOwner | null> => {
  const attach = async (contactId: string): Promise<EmailOwner> => {
    const { identity } = await attachVerifiedIdentity(tx, brandId, contactId, portalClaim(email));
    return { contactId, identityId: identity.id };
  };

  const holder = await findEmailOwner(tx, brandId, email);
  if (holder !== null) {
    return attach(holder.contactId);
  }
  if (!options.create || (await emailIsHeld(tx, brandId, email))) {
    return null;
  }
  try {
    const created = await tx.transaction((savepoint) =>
      findOrCreateContactByIdentity(savepoint, brandId, portalClaim(email), {
        name: email.split('@')[0] ?? email,
      }),
    );
    if (created.identity === null) {
      throw new Error('A portal sign-in claim is verified, so its identity is always recorded');
    }
    return { contactId: created.contact.id, identityId: created.identity.id };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    const raced = await findEmailOwner(tx, brandId, email);
    return raced === null ? null : attach(raced.contactId);
  }
};

/** The identity of this contact holding exactly `email`, if it is still there. */
export const findIdentityOf = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
  email: string,
): Promise<string | null> => {
  const [row] = await tx
    .select({ id: contactIdentities.id })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.brandId, brandId),
        eq(contactIdentities.contactId, contactId),
        eq(contactIdentities.kind, 'email'),
        eq(contactIdentities.value, email),
      ),
    )
    .limit(1);
  return row?.id ?? null;
};

export const insertSession = async (
  tx: DbTransaction,
  input: {
    readonly brandId: string;
    readonly contactId: string;
    readonly identityId: string;
    readonly tokenHash: string;
    readonly host: string;
    readonly userAgentFamily: string | null;
    readonly now: Date;
  },
): Promise<void> => {
  await tx.insert(customerSessions).values({
    brandId: input.brandId,
    contactId: input.contactId,
    contactIdentityId: input.identityId,
    tokenHash: input.tokenHash,
    createdAt: input.now,
    lastSeenAt: input.now,
    expiresAt: sessionExpiry(input.now),
    userAgentFamily: input.userAgentFamily,
    host: input.host,
  });
};

export interface LiveSession {
  readonly id: string;
  /** What the customer may see, read from the database on this request (`loadCustomerScope`). Set by the guard. */
  readonly scope?: CustomerScope;
  /** The expiry was pushed forward by this request, so the cookie's lifetime must be too. */
  readonly touched: boolean;
  readonly brandId: string;
  readonly contactId: string;
  readonly address: string;
  readonly companyName: string | null;
}

/**
 * The session a cookie names, or null. It must belong to this brand and to the
 * host it was issued on, be unexpired, and its identity must still be there,
 * verified, on a contact that is not merged away or anonymised. A session that
 * fails any of these is deleted on the spot. A live one has its expiry pushed
 * forward at most once per touch interval.
 */
export const resolveSession = async (
  tx: DbTransaction,
  input: {
    readonly brandId: string;
    readonly token: string;
    readonly host: string;
    readonly now: Date;
  },
): Promise<LiveSession | null> => {
  const hash = hashToken(input.token);
  const [row] = await tx
    .select({
      id: customerSessions.id,
      brandId: customerSessions.brandId,
      contactId: customerSessions.contactId,
      host: customerSessions.host,
      tokenHash: customerSessions.tokenHash,
      lastSeenAt: customerSessions.lastSeenAt,
      expiresAt: customerSessions.expiresAt,
      address: contactIdentities.value,
      verified: contactIdentities.verified,
      identityContactId: contactIdentities.contactId,
      mergedIntoId: contacts.mergedIntoId,
      anonymisedAt: contacts.anonymisedAt,
      accountId: contacts.accountId,
    })
    .from(customerSessions)
    .innerJoin(contactIdentities, eq(contactIdentities.id, customerSessions.contactIdentityId))
    .innerJoin(contacts, eq(contacts.id, customerSessions.contactId))
    .where(eq(customerSessions.tokenHash, hash))
    .limit(1);
  if (row === undefined || !sameHash(row.tokenHash, hash)) {
    return null;
  }
  if (row.brandId !== input.brandId || row.host !== input.host) {
    // Not this brand's or this host's session: not ours to delete either.
    return null;
  }
  const usable =
    !isExpired(row.expiresAt, input.now) &&
    row.verified &&
    row.identityContactId === row.contactId &&
    row.mergedIntoId === null &&
    row.anonymisedAt === null;
  if (!usable) {
    await tx.delete(customerSessions).where(eq(customerSessions.id, row.id));
    return null;
  }
  const touched = shouldTouch(row.lastSeenAt, input.now);
  if (touched) {
    await tx
      .update(customerSessions)
      .set({ lastSeenAt: input.now, expiresAt: sessionExpiry(input.now) })
      .where(eq(customerSessions.id, row.id));
  }
  const [account] =
    row.accountId === null
      ? []
      : await tx
          .select({ name: accounts.name })
          .from(accounts)
          .where(and(eq(accounts.id, row.accountId), eq(accounts.brandId, row.brandId)))
          .limit(1);
  return {
    id: row.id,
    brandId: row.brandId,
    contactId: row.contactId,
    address: row.address,
    companyName: account?.name ?? null,
    touched,
  };
};

export const deleteSession = async (tx: DbTransaction, id: string): Promise<void> => {
  await tx.delete(customerSessions).where(eq(customerSessions.id, id));
};

/** Every session of a contact in a brand, this one included. Returns how many ended. */
export const deleteContactSessions = async (
  tx: DbTransaction,
  brandId: string,
  contactId: string,
): Promise<number> => {
  const gone = await tx
    .delete(customerSessions)
    .where(and(eq(customerSessions.brandId, brandId), eq(customerSessions.contactId, contactId)))
    .returning({ id: customerSessions.id });
  return gone.length;
};
