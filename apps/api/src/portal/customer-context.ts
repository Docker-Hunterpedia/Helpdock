import {
  accounts,
  brands,
  contacts,
  customerContext,
  type Db,
  type DbTransaction,
  type RequestFacts,
  type TenantContext,
  withTenant,
} from '@helpdock/db';
import {
  type AccountRole,
  type CustomerSees,
  customerSees,
  type PortalVisibility,
  parseBrandSettings,
} from '@helpdock/schemas';
import { and, eq } from 'drizzle-orm';

/**
 * Opens a transaction as a portal customer (M21-01, ADR 0060). The portal's
 * guard (M21-02) and its pages (M21-03 onwards) go through here and nowhere
 * else, so `sees`, the account and the departments the brand shows are always
 * read from the database on the request, never trusted from a cookie or from
 * an earlier request: a staff change of an account's setting or a contact's
 * role takes effect on the next request.
 */

export type CustomerContextRefusal =
  /** No such contact in this brand, or it was merged away or erased. */
  | 'contact-unavailable'
  /** The brand has the portal off; no customer context exists then (ADR 0059 §8). */
  | 'portal-disabled'
  /** The brand is not active (in its deletion grace, purged) or is soft-deleted. */
  | 'brand-unavailable';

/** Thrown, with a reason and no ids, when a customer context cannot be opened. */
export class CustomerContextError extends Error {
  readonly reason: CustomerContextRefusal;

  constructor(reason: CustomerContextRefusal) {
    super(`Cannot open a customer context: ${reason}`);
    this.name = 'CustomerContextError';
    this.reason = reason;
  }
}

/** What the system-side read of a customer's facts returns. */
export interface CustomerScope {
  readonly brandId: string;
  readonly contactId: string;
  /** The contact's account, when it has one that still exists in this brand. */
  readonly accountId: string | null;
  readonly sees: CustomerSees;
  /**
   * The account's setting and the contact's role, for the notices a page draws
   * ("people at your company can see your tickets"). They never reach the
   * policy: `sees` is what it reads. `own` and `member` when there is no account.
   */
  readonly visibility: PortalVisibility;
  readonly role: AccountRole;
  /** The departments the brand shows in the portal (D-65): a list, or every one. */
  readonly departmentIds: readonly string[] | 'all';
}

/** The jobId the read of the facts is audited under. */
const FACTS_JOB_ID = 'portal:customer-facts';

/**
 * Reads, on the explicit system path, who this customer is and what they may
 * see: the contact's account, the account's setting, the contact's role and the
 * brand's portal settings. This is the one place a customer's scope is decided;
 * the policies enforce whatever it returns.
 */
export const loadCustomerScope = (
  db: Db,
  input: { readonly brandId: string; readonly contactId: string },
): Promise<CustomerScope> =>
  withTenant(
    db,
    {
      brandIds: [input.brandId],
      departmentIds: 'all',
      principalType: 'system',
      principalId: FACTS_JOB_ID,
    },
    async (tx: DbTransaction) => {
      const [brand] = await tx
        .select({ settings: brands.settings, status: brands.status, deletedAt: brands.deletedAt })
        .from(brands)
        .where(eq(brands.id, input.brandId))
        .limit(1);
      if (brand === undefined || brand.status !== 'active' || brand.deletedAt !== null) {
        throw new CustomerContextError('brand-unavailable');
      }
      const portal = parseBrandSettings(brand.settings).portal;
      if (!portal.enabled) {
        throw new CustomerContextError('portal-disabled');
      }

      const [contact] = await tx
        .select({
          accountId: contacts.accountId,
          role: contacts.accountRole,
          mergedIntoId: contacts.mergedIntoId,
          anonymisedAt: contacts.anonymisedAt,
        })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.brandId, input.brandId)))
        .limit(1);
      if (contact === undefined || contact.mergedIntoId !== null || contact.anonymisedAt !== null) {
        throw new CustomerContextError('contact-unavailable');
      }

      const [account] =
        contact.accountId === null
          ? []
          : await tx
              .select({ visibility: accounts.portalVisibility })
              .from(accounts)
              .where(and(eq(accounts.id, contact.accountId), eq(accounts.brandId, input.brandId)))
              .limit(1);

      return {
        contactId: input.contactId,
        brandId: input.brandId,
        accountId: account === undefined ? null : contact.accountId,
        sees: customerSees({
          hasAccount: account !== undefined,
          visibility: account?.visibility ?? 'own',
          role: contact.role,
        }),
        visibility: account?.visibility ?? 'own',
        role: account === undefined ? 'member' : contact.role,
        departmentIds: portal.departmentIds,
      };
    },
  );

/** The tenant context for a scope {@link loadCustomerScope} returned. */
export const customerTenantContext = (
  scope: CustomerScope,
  request?: RequestFacts,
): TenantContext =>
  customerContext({
    brandId: scope.brandId,
    contactId: scope.contactId,
    accountId: scope.accountId,
    sees: scope.sees,
    departmentIds: scope.departmentIds,
    request,
  });

/**
 * Reads the scope, then runs `fn` in a transaction that carries it. `fn`
 * receives the scope too, so a page can show "your company can see your
 * tickets" from the same read the policy used.
 */
export const withCustomerContext = async <T>(
  db: Db,
  input: { readonly brandId: string; readonly contactId: string; readonly request?: RequestFacts },
  fn: (tx: DbTransaction, scope: CustomerScope) => Promise<T>,
): Promise<T> => {
  const scope = await loadCustomerScope(db, input);

  return withTenant(db, customerTenantContext(scope, input.request), (tx) => fn(tx, scope));
};
