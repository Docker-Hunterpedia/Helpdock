import type { Account as AccountRow, DbTransaction } from '@helpdock/db';
import type {
  Account,
  AccountCreateRequest,
  AccountList,
  AccountSearchQuery,
  AccountUpdateRequest,
  ContactSummary,
} from '@helpdock/schemas';
import { CONTACT_PAGE_SIZE } from '@helpdock/schemas';
import { NotFoundException } from '@nestjs/common';
import { writeContactAudit } from './audit.js';
import { ContactFailure } from './contact-failure.js';
import { accountView, byContact, summaryView } from './contact-view.js';
import type { ContactsRepository } from './contacts.repository.js';
import type { ContactContext } from './contacts.service.js';
import { EMPTY_CONTACT_STATS } from './providers.js';

/**
 * The customer companies of one brand. Small on purpose: M1-04 gives an account
 * a name, a domain and the contacts filed under it, and M1-06 adds the custom
 * fields that make it worth more than that.
 *
 * A domain is lower-cased before it is stored, because `Acme.example` and
 * `acme.example` are the same company and the unique index is per brand.
 */
export class AccountsService {
  readonly #repository: ContactsRepository;

  constructor({ repository }: { readonly repository: ContactsRepository }) {
    this.#repository = repository;
  }

  async list(context: ContactContext, query: AccountSearchQuery): Promise<AccountList> {
    const { tx } = context;
    const page = await this.#repository.listAccounts(tx, {
      search: query.search,
      cursor: query.cursor,
      limit: query.limit ?? CONTACT_PAGE_SIZE,
    });

    const counts = await this.#repository.contactCounts(
      tx,
      page.rows.map((row) => row.id),
    );

    return {
      accounts: page.rows.map((row) => accountView(row, counts.get(row.id) ?? 0)),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  async detail(
    context: ContactContext,
    accountId: string,
  ): Promise<{ account: Account; contacts: ContactSummary[] }> {
    const { tx } = context;
    const account = await this.#require(tx, accountId);
    const rows = await this.#repository.contactsOfAccount(tx, accountId);
    const identities = byContact(
      await this.#repository.identitiesOf(
        tx,
        rows.map((row) => row.id),
      ),
    );

    return {
      account: accountView(account, rows.length),
      contacts: rows.map((row) =>
        summaryView(row, {
          identities: identities.get(row.id) ?? [],
          account,
          stats: EMPTY_CONTACT_STATS,
        }),
      ),
    };
  }

  async create(context: ContactContext, request: AccountCreateRequest): Promise<Account> {
    const { tx, brandId, actor } = context;
    const domain = await this.#freeDomain(tx, request.domain ?? null, null);

    const account = await this.#repository.insertAccount(tx, {
      brandId,
      name: request.name,
      domain,
    });

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'account.created',
      targetType: 'account',
      targetId: account.id,
      meta: { hasDomain: domain !== null },
    });

    return accountView(account, 0);
  }

  async update(
    context: ContactContext,
    accountId: string,
    request: AccountUpdateRequest,
  ): Promise<Account> {
    const { tx, brandId, actor } = context;
    const existing = await this.#require(tx, accountId);

    const changes = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...(request.domain === undefined
        ? {}
        : { domain: await this.#freeDomain(tx, request.domain ?? null, existing.id) }),
    };

    const updated = await this.#repository.updateAccount(tx, accountId, changes);
    /* c8 ignore next 3 -- the row was read in this same transaction. */
    if (updated === undefined) {
      throw new NotFoundException('No such account');
    }

    await writeContactAudit(tx, {
      brandId,
      actorId: actor.userId,
      action: 'account.updated',
      targetType: 'account',
      targetId: accountId,
      meta: { fields: Object.keys(changes) },
    });

    const counts = await this.#repository.contactCounts(tx, [accountId]);

    return accountView(updated, counts.get(accountId) ?? 0);
  }

  // ------------------------------------------------------------------

  /**
   * The domain, normalised, once it is known that no other account of this
   * brand claims it. The unique index would refuse it anyway; catching it here
   * turns a constraint violation into the sentence the form shows.
   */
  async #freeDomain(
    tx: DbTransaction,
    raw: string | null,
    selfId: string | null,
  ): Promise<string | null> {
    const domain = raw?.trim().toLowerCase().replace(/^@/, '') ?? '';
    if (domain === '') {
      return null;
    }

    const owner = await this.#repository.accountByDomain(tx, domain);
    if (owner !== undefined && owner.id !== selfId) {
      throw new ContactFailure('domain-taken');
    }

    return domain;
  }

  async #require(tx: DbTransaction, accountId: string): Promise<AccountRow> {
    const account = await this.#repository.account(tx, accountId);
    if (account === undefined) {
      throw new NotFoundException('No such account');
    }

    return account;
  }
}
