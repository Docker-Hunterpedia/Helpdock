import {
  type QuickSearch,
  type QuickSearchQuery,
  quickSearchSchema,
  type Session,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';
import { seededRole } from '../auth/mock-api.js';
import type { ContactsApi } from '../contacts/api.js';
import type { HelpCenterApi } from '../help-center/api.js';
import type { TicketsApi } from '../tickets/api.js';
import { fold } from './fold.js';

/**
 * The command palette's one read (M14-05): `GET /api/brands/:brandId/quick-search`.
 * `MockQuickSearchApi` answers from the ticket, contact and help-center
 * fixtures for the unit tests and the mock Playwright projects.
 */
export interface QuickSearchApi {
  search(
    brandId: string,
    query: Pick<QuickSearchQuery, 'q' | 'limit' | 'locale'>,
    signal?: AbortSignal,
  ): Promise<QuickSearch>;
}

export class HttpQuickSearchApi implements QuickSearchApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async search(
    brandId: string,
    { q, limit, locale }: Pick<QuickSearchQuery, 'q' | 'limit' | 'locale'>,
    signal?: AbortSignal,
  ): Promise<QuickSearch> {
    const params = new URLSearchParams({ q, limit: String(limit), locale });
    return quickSearchSchema.parse(
      await this.#transport.request(
        'GET',
        `/brands/${encodeURIComponent(brandId)}/quick-search?${params.toString()}`,
        undefined,
        signal === undefined ? {} : { signal },
      ),
    );
  }
}

/**
 * Set to a section name (`tickets`, `contacts` or `articles`) in local storage
 * before the app loads, it makes the fixture answer that section as failed,
 * which is how a browser test sees the palette's retry notice.
 */
export const MOCK_QUICK_SEARCH_FAIL_STORAGE = 'helpdock.mock.quickSearchFail';
/** The same, in milliseconds, for how long the fixture takes to answer. */
export const MOCK_QUICK_SEARCH_DELAY_STORAGE = 'helpdock.mock.quickSearchDelayMs';

const seeded = (key: string): string => {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
};

type Role = Session['user']['role'];

export class MockQuickSearchApi implements QuickSearchApi {
  readonly #tickets: Pick<TicketsApi, 'list'>;
  readonly #contacts: Pick<ContactsApi, 'listContacts'>;
  readonly #helpCenter: Pick<HelpCenterApi, 'structure'>;
  readonly #role: () => Role;
  /** Sections currently failing: a test's `failNext` plus the seeded one. */
  #failing = new Set<string>();

  constructor(
    sources: {
      readonly tickets: Pick<TicketsApi, 'list'>;
      readonly contacts: Pick<ContactsApi, 'listContacts'>;
      readonly helpCenter: Pick<HelpCenterApi, 'structure'>;
    },
    role: () => Role = () => seededRole() ?? 'admin',
  ) {
    this.#tickets = sources.tickets;
    this.#contacts = sources.contacts;
    this.#helpCenter = sources.helpCenter;
    this.#role = role;
    const failing = seeded(MOCK_QUICK_SEARCH_FAIL_STORAGE);
    if (failing !== '') {
      this.#failing = new Set(failing.split(','));
    }
  }

  /** Makes the section fail on the next searches until it is cleared. */
  failSection(section: 'tickets' | 'contacts' | 'articles', failing = true): void {
    if (failing) {
      this.#failing.add(section);
    } else {
      this.#failing.delete(section);
    }
  }

  async search(
    brandId: string,
    { q, limit }: Pick<QuickSearchQuery, 'q' | 'limit' | 'locale'>,
    signal?: AbortSignal,
  ): Promise<QuickSearch> {
    const delay = Number(seeded(MOCK_QUICK_SEARCH_DELAY_STORAGE)) || 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    signal?.throwIfAborted();

    const role = this.#role();
    const section = async <T>(name: string, read: () => Promise<T[]>) =>
      this.#failing.has(name)
        ? ({ status: 'failed' } as const)
        : ({ status: 'ok', items: await read() } as const);

    return {
      tickets: await section('tickets', async () =>
        (await this.#tickets.list(brandId, { q, limit })).tickets.map(
          ({ id, number, prefix, subject }) => ({ id, number, prefix, subject }),
        ),
      ),
      contacts: await section('contacts', async () =>
        (await this.#contacts.listContacts(brandId, { search: q, limit })).contacts.map(
          ({ id, name, primaryIdentity }) => ({
            id,
            name,
            identity: primaryIdentity?.value ?? null,
          }),
        ),
      ),
      articles: await section('articles', async () => {
        const manages = role === 'admin' || role === 'teamLeader';
        const wanted = fold(q);
        const { articles } = await this.#helpCenter.structure(brandId);
        return articles
          .flatMap((article) => {
            const version = article.versions.find(
              (candidate) =>
                candidate.status !== 'archived' &&
                (manages || candidate.status === 'published') &&
                fold(candidate.title).includes(wanted),
            );
            return version === undefined || version.status === 'archived'
              ? []
              : [{ id: article.id, title: version.title, status: version.status }];
          })
          .slice(0, limit);
      }),
    };
  }
}
