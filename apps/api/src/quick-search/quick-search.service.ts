import {
  type QuickSearch,
  type QuickSearchArticle,
  type QuickSearchContact,
  type QuickSearchQuery,
  type QuickSearchSection,
  type QuickSearchTicket,
  ticketListQuerySchema,
} from '@helpdock/schemas';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { RateLimiter, RateLimitRule } from '../auth/rate-limit.js';
import { contactContext } from '../contacts/contact-context.js';
import type { ContactsService } from '../contacts/contacts.service.js';
import { getTx, requireRequestContext } from '../context/request-context.js';
import type { HelpCenterSearch } from '../help-center/ports.js';
import type { TicketsService } from '../tickets/tickets.service.js';

/**
 * The palette's one read (M14-05), `GET /quick-search`.
 *
 * It reuses the reads the screens already trust instead of a search of its own,
 * so a person finds exactly what the list, the contacts page and the help
 * center would show them and no more:
 *
 * - **Tickets** through the list's search, whose exact reference or number
 *   comes first (ADR 0011), under the request transaction's row-level
 *   security: a ticket in another department is not there to find.
 * - **Contacts** through the contacts search.
 * - **Articles** through the staff audience of help-center search (published
 *   versions, public and internal), plus draft titles for who manages them.
 *
 * Each section is judged alone. One the person has no permission for is
 * skipped; one that errors or runs past {@link SECTION_BUDGET_MS} is `failed`
 * and the others still answer. The sections that share the request's
 * transaction run inside a savepoint with a statement timeout, so a failure
 * rolls back to the savepoint instead of poisoning the transaction.
 */

/** DESIGN and the plan: 300 ms for each section. */
export const SECTION_BUDGET_MS = 300;

/** Ten requests a second for one person, which is a fast typist behind the 150 ms debounce. */
export const QUICK_SEARCH_RULE: RateLimitRule = {
  bucket: 'quick-search',
  limit: 10,
  windowSeconds: 1,
};

export interface QuickSearchScope {
  readonly brandId: string;
  readonly viewerId: string;
  readonly can: {
    readonly tickets: boolean;
    readonly contacts: boolean;
    readonly articles: boolean;
    readonly manageArticles: boolean;
  };
}

export class QuickSearchService {
  readonly #logger = new Logger(QuickSearchService.name);
  readonly #tickets: TicketsService;
  readonly #contacts: ContactsService;
  readonly #articles: HelpCenterSearch;
  readonly #limiter: Pick<RateLimiter, 'consume'>;

  constructor(
    tickets: TicketsService,
    contacts: ContactsService,
    articles: HelpCenterSearch,
    limiter: Pick<RateLimiter, 'consume'>,
  ) {
    this.#tickets = tickets;
    this.#contacts = contacts;
    this.#articles = articles;
    this.#limiter = limiter;
  }

  async search(
    scope: QuickSearchScope,
    { q, limit, locale }: QuickSearchQuery,
  ): Promise<QuickSearch> {
    if (!(await this.#limiter.consume(QUICK_SEARCH_RULE, scope.viewerId))) {
      throw new HttpException('Too many searches; wait a moment', HttpStatus.TOO_MANY_REQUESTS);
    }

    // One after another: they share one connection, and a savepoint cannot be
    // taken while another section's statements are in flight.
    const tickets = await this.#section(scope.can.tickets, 'tickets', () =>
      this.#ticketHits(scope, q, limit),
    );
    const contacts = await this.#section(scope.can.contacts, 'contacts', () =>
      this.#contactHits(q, limit),
    );
    const articles = await this.#section(scope.can.articles, 'articles', () =>
      this.#articleHits(scope, q, limit, locale),
    );
    return { tickets, contacts, articles };
  }

  async #ticketHits(
    scope: QuickSearchScope,
    q: string,
    limit: number,
  ): Promise<QuickSearchTicket[]> {
    const list = await this.#tickets.list(
      { brandId: scope.brandId, viewerId: scope.viewerId },
      ticketListQuerySchema.parse({ q, limit }),
      { withContacts: false },
    );
    return list.tickets.map(({ id, number, prefix, subject }) => ({ id, number, prefix, subject }));
  }

  async #contactHits(q: string, limit: number): Promise<QuickSearchContact[]> {
    const list = await this.#contacts.list(contactContext(), { search: q, limit });
    return list.contacts.map(({ id, name, primaryIdentity }) => ({
      id,
      name,
      identity: primaryIdentity?.value ?? null,
    }));
  }

  async #articleHits(
    scope: QuickSearchScope,
    q: string,
    limit: number,
    locale: QuickSearchQuery['locale'],
  ): Promise<QuickSearchArticle[]> {
    const found = await withBudget(
      this.#articles.search({
        brandId: scope.brandId,
        audience: 'internal',
        locale,
        q,
        limit,
        offset: 0,
        source: 'help_center',
        log: false,
      }),
    );
    const published = found.hits.map(
      (hit): QuickSearchArticle => ({ id: hit.articleId, title: hit.title, status: 'published' }),
    );
    if (!scope.can.manageArticles || published.length >= limit) {
      return published;
    }
    const drafts = await draftTitles(q, limit - published.length);
    const known = new Set(published.map(({ id }) => id));
    return [...published, ...drafts.filter(({ id }) => !known.has(id))].slice(0, limit);
  }

  async #section<Item>(
    allowed: boolean,
    name: string,
    read: () => Promise<Item[]>,
  ): Promise<QuickSearchSection<Item>> {
    if (!allowed) {
      return { status: 'skipped' };
    }
    const context = requireRequestContext();
    const outer = getTx();
    const [before] = await outer.execute<{ timeout: string }>(
      sql`select current_setting('statement_timeout') as timeout`,
    );
    try {
      // A nested transaction is a savepoint that the driver itself tracks: a
      // statement that fails inside it is rolled back and does not mark the
      // request's transaction as failed. The services under it read the
      // transaction from the request context, so it stands in for the outer
      // one while they run. The statement timeout makes the database cancel a
      // slow query; the rollback only happens once that has settled.
      const items = await outer.transaction(async (nested) => {
        context.tx = nested;
        await nested.execute(
          sql`select set_config('statement_timeout', ${`${SECTION_BUDGET_MS}ms`}, true)`,
        );
        return read();
      });
      await outer.execute(
        sql`select set_config('statement_timeout', ${before?.timeout ?? '0'}, true)`,
      );
      return { status: 'ok', items };
    } catch (error) {
      this.#logger.warn(
        `The ${name} section failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return { status: 'failed' };
    } finally {
      context.tx = outer;
    }
  }
}

/** Rejects when a read outlasts its budget. Only for the search, which runs on a connection of its own. */
const withBudget = async <T>(read: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('The section ran past its budget'));
    }, SECTION_BUDGET_MS);
  });
  try {
    return await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
};

interface DraftRow extends Record<string, unknown> {
  readonly article_id: string;
  readonly title: string;
  readonly status: 'draft' | 'scheduled';
}

/**
 * Titles of articles with a working copy not yet published, newest edit first.
 * One row per article: the language the editor last touched. Row-level
 * security keeps it to the brand.
 */
const draftTitles = async (q: string, limit: number): Promise<QuickSearchArticle[]> => {
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await getTx().execute<DraftRow>(sql`
    select distinct on (article_id) article_id, title, status::text as status
    from hc_article_versions
    where status in ('draft', 'scheduled') and title ilike ${pattern}
    order by article_id, updated_at desc
    limit ${limit}`);
  return rows.map((row) => ({ id: row.article_id, title: row.title, status: row.status }));
};
