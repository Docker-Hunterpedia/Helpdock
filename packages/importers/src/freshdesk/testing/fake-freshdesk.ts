import { z } from 'zod';
import { type VendorAnswer, VendorServer } from '../../testing/vendor-server.js';

// Keep wire fixtures independent from production response parsers.
const rowSchema = z.looseObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  created_at: z.iso.datetime({ offset: true }).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
const ticketSchema = rowSchema.extend({
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
  spam: z.boolean().optional(),
});
const contactSchema = rowSchema.extend({ deleted: z.boolean().optional() });
const conversationSchema = rowSchema.extend({ ticket_id: z.number().int().positive() });
const ratingSchema = rowSchema.extend({ ticket_id: z.number().int().positive() });
const surveySchema = z.looseObject({ id: z.string(), title: z.string(), state: z.string() });
const surveyResponseSchema = z.looseObject({
  id: z.string(),
  survey_id: z.string(),
  ticket_id: z.number().int().positive(),
});

const fixtureSchema = z.strictObject({
  tickets: z.array(ticketSchema).default([]),
  contacts: z.array(contactSchema).default([]),
  companies: z.array(rowSchema).default([]),
  agents: z.array(rowSchema).default([]),
  groups: z.array(rowSchema).default([]),
  ticket_fields: z.array(rowSchema).default([]),
  contact_fields: z.array(rowSchema).default([]),
  company_fields: z.array(rowSchema).default([]),
  satisfaction_ratings: z.array(ratingSchema).default([]),
  surveys: z.array(surveySchema).default([]),
  survey_responses: z.record(z.string(), z.array(surveyResponseSchema)).default({}),
  conversations: z.record(z.string(), z.array(conversationSchema)).default({}),
  categories: z.array(rowSchema).default([]),
  folders: z.record(z.string(), z.array(rowSchema)).default({}),
  subfolders: z.record(z.string(), z.array(rowSchema)).default({}),
  articles: z.record(z.string(), z.array(rowSchema)).default({}),
  translations: z.record(z.string(), z.record(z.string(), rowSchema)).default({}),
  helpdesk_settings: z
    .object({ primary_language: z.string(), supported_languages: z.array(z.string()) })
    .default({ primary_language: 'en', supported_languages: [] }),
});
export type FreshdeskFixture = z.input<typeof fixtureSchema>;
type Row = { id: number; updated_at?: string | undefined; created_at?: string | undefined };

/** Documented v2 arrays/Link paging; no invented archived-ticket enumeration endpoint. */
export class FakeFreshdesk {
  readonly server: VendorServer;
  private fixture: z.infer<typeof fixtureSchema>;
  private readonly media = new Map<number, Buffer>();
  private readonly downloads = new Map<string, number>();
  private nextDownload = 0;

  constructor(
    fixture: FreshdeskFixture,
    private readonly options: {
      authorization: string;
      now: number;
      pageSize?: number;
    },
  ) {
    this.fixture = fixtureSchema.parse(fixture);
    this.server = new VendorServer((url, authorization) => this.route(url, authorization));
  }

  replaceFixture(fixture: FreshdeskFixture): void {
    this.fixture = fixtureSchema.parse(fixture);
  }
  addAttachment(id: number, bytes: Buffer): string {
    this.media.set(z.number().int().positive().parse(id), Buffer.from(bytes));
    return this.downloadUrl(id);
  }
  expireDownloads(): void {
    this.downloads.clear();
  }

  private downloadUrl(id: number): string {
    const token = String(++this.nextDownload);
    this.downloads.set(token, id);
    return `${this.server.root}/data/helpdesk/attachments/production/${id}/original/file?token=${token}`;
  }

  private refreshed(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.refreshed(item));
    if (value === null || typeof value !== 'object') return value;
    const row = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(row).map(([key, item]) => [key, this.refreshed(item)]),
    );
    if (
      typeof row.id === 'number' &&
      typeof row.attachment_url === 'string' &&
      this.media.has(row.id)
    )
      result.attachment_url = this.downloadUrl(row.id);
    return result;
  }

  private route(url: URL, authorization: string | undefined): VendorAnswer {
    const download = /^\/data\/helpdesk\/attachments\/production\/(\d+)\/original\/file$/.exec(
      url.pathname,
    );
    if (download) {
      const id = Number(download[1]);
      const bytes = this.media.get(id);
      if (authorization)
        return { status: 400, json: { error: 'Credentials reached attachment host' } };
      return bytes && this.downloads.get(url.searchParams.get('token') ?? '') === id
        ? { status: 200, bytes }
        : { status: 403, json: { error: 'Expired attachment URL' } };
    }
    if (authorization !== this.options.authorization)
      return { status: 401, json: { code: 'invalid_credentials' } };
    if (url.pathname === '/api/v2/customer-satisfaction/surveys')
      return this.tokenPage(url, this.fixture.surveys);
    const responses = /^\/api\/v2\/customer-satisfaction\/surveys\/([^/]+)\/responses$/.exec(
      url.pathname,
    );
    if (responses)
      return this.fixture.surveys.some((row) => row.id === responses[1])
        ? this.tokenPage(url, this.fixture.survey_responses[responses[1] ?? ''] ?? [])
        : this.notFound();
    if (url.pathname === '/api/v2/agents/me') {
      const agent = this.fixture.agents[0];
      return agent ? { status: 200, json: agent } : this.notFound();
    }
    const person = /^\/api\/v2\/(agents|contacts)\/(\d+)$/.exec(url.pathname);
    if (person) {
      const rows = person[1] === 'agents' ? this.fixture.agents : this.fixture.contacts;
      const row = rows.find((item) => String(item.id) === person[2]);
      return row ? { status: 200, json: row } : this.notFound();
    }
    const ticket =
      /^\/api\/v2\/tickets\/(archived\/)?(\d+)(\/conversations|\/satisfaction_ratings)?$/.exec(
        url.pathname,
      );
    if (ticket) {
      const id = ticket[2] ?? '';
      const archived = Boolean(ticket[1]);
      const row = this.fixture.tickets.find(
        (item) => String(item.id) === id && Boolean(item.archived) === archived,
      );
      if (!row) return this.notFound();
      if (ticket[3] === '/conversations')
        return this.page(url, this.fixture.conversations[id] ?? []);
      if (ticket[3] === '/satisfaction_ratings' && !archived)
        return this.page(
          url,
          this.fixture.satisfaction_ratings.filter((item) => String(item.ticket_id) === id),
        );
      return ticket[3] ? this.notFound() : { status: 200, json: this.refreshed(row) };
    }
    const collection =
      /^\/api\/v2\/(tickets|contacts|companies|agents|groups|ticket_fields|contact_fields|company_fields)$/.exec(
        url.pathname,
      );
    if (collection) {
      switch (collection[1]) {
        case 'tickets': {
          const filter = url.searchParams.get('filter');
          const rows = this.fixture.tickets.filter(
            (row) =>
              !row.archived &&
              (filter === 'deleted'
                ? row.deleted
                : filter === 'spam'
                  ? row.spam
                  : !row.deleted && !row.spam),
          );
          return this.page(url, rows, { tickets: true });
        }
        case 'contacts': {
          const state = url.searchParams.get('state');
          return this.page(
            url,
            this.fixture.contacts.filter((row) =>
              state === 'deleted' ? row.deleted : !row.deleted,
            ),
          );
        }
        case 'companies':
          return this.page(url, this.fixture.companies);
        case 'agents':
          return this.page(url, this.fixture.agents);
        case 'groups':
          return this.page(url, this.fixture.groups);
        case 'ticket_fields':
          return this.page(url, this.fixture.ticket_fields);
        case 'contact_fields':
          return this.page(url, this.fixture.contact_fields);
        case 'company_fields':
          return this.page(url, this.fixture.company_fields);
      }
    }
    if (url.pathname === '/api/v2/settings/helpdesk')
      return { status: 200, json: this.fixture.helpdesk_settings };
    const resource =
      /^\/api\/v2\/solutions\/(categories|folders|articles)\/(\d+)(?:\/([^/]+))?$/.exec(
        url.pathname,
      );
    if (resource && !['folders', 'subfolders', 'articles'].includes(resource[3] ?? '')) {
      const collection = resource[1];
      const id = resource[2] ?? '';
      const locale = resource[3];
      if (locale) {
        const kind =
          collection === 'categories'
            ? 'category'
            : collection === 'folders'
              ? 'folder'
              : 'article';
        const translated = this.fixture.translations[`${kind}:${id}`]?.[locale];
        return translated ? { status: 200, json: translated } : this.notFound();
      }
      if (collection === 'categories') {
        const row = this.fixture.categories.find((item) => String(item.id) === id);
        return row ? { status: 200, json: row } : this.notFound();
      }
      const groups =
        collection === 'folders'
          ? [this.fixture.folders, this.fixture.subfolders]
          : [this.fixture.articles];
      for (const group of groups)
        for (const rows of Object.values(group)) {
          const row = rows.find((item) => String(item.id) === id);
          if (row) return { status: 200, json: row };
        }
      return this.notFound();
    }
    if (url.pathname === '/api/v2/surveys/satisfaction_ratings')
      return this.page(url, this.fixture.satisfaction_ratings, { createdSince: true });
    if (url.pathname === '/api/v2/solutions/categories')
      return this.page(url, this.fixture.categories);
    const nested =
      /^\/api\/v2\/solutions\/(categories|folders)\/(\d+)\/(folders|subfolders|articles)$/.exec(
        url.pathname,
      );
    if (nested) {
      const id = nested[2] ?? '';
      if (nested[1] === 'categories' && nested[3] === 'folders')
        return this.page(url, this.fixture.folders[id] ?? []);
      if (nested[1] === 'folders' && nested[3] === 'subfolders')
        return this.page(url, this.fixture.subfolders[id] ?? []);
      if (nested[1] === 'folders' && nested[3] === 'articles')
        return this.page(url, this.fixture.articles[id] ?? []);
    }
    return this.notFound();
  }

  private page(
    url: URL,
    input: readonly Row[],
    mode: { tickets?: boolean; createdSince?: boolean } = {},
  ): VendorAnswer {
    const page = Number(url.searchParams.get('page') ?? 1);
    const requested = Number(url.searchParams.get('per_page') ?? 30);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > 100 ||
      (mode.tickets && page > 300)
    )
      return { status: 400, json: { code: 'invalid_value' } };
    const pageSize = Math.min(requested, this.options.pageSize ?? requested);
    const rawSince = url.searchParams.get(mode.createdSince ? 'created_since' : 'updated_since');
    if (rawSince && !Number.isFinite(Date.parse(rawSince)))
      return { status: 400, json: { code: 'invalid_value' } };
    const since = rawSince
      ? Date.parse(rawSince)
      : mode.tickets
        ? this.options.now - 30 * 86400000
        : null;
    let rows = input.filter(
      (row) =>
        since === null ||
        Date.parse(
          (mode.createdSince || (mode.tickets && !rawSince) ? row.created_at : row.updated_at) ??
            '',
        ) >= since,
    );
    if (mode.tickets) {
      const order = url.searchParams.get('order_by') ?? 'created_at';
      if (!['created_at', 'updated_at', 'due_by', 'status'].includes(order))
        return { status: 400, json: { code: 'invalid_value' } };
      const direction = url.searchParams.get('order_type') === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const left = (a as Record<string, unknown>)[order];
        const right = (b as Record<string, unknown>)[order];
        return direction * (String(left).localeCompare(String(right)) || a.id - b.id);
      });
    }
    const start = (page - 1) * pageSize;
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    const hasNext = start + pageSize < rows.length && (!mode.tickets || page < 300);
    return {
      status: 200,
      json: this.refreshed(rows.slice(start, start + pageSize)),
      headers: {
        'X-RateLimit-Total': '100',
        'X-RateLimit-Remaining': '99',
        'X-RateLimit-Used-CurrentRequest': '1',
        ...(hasNext ? { link: `<${next.href}>; rel="next"` } : {}),
      },
    };
  }

  private notFound(): VendorAnswer {
    return { status: 404, json: { code: 'not_found' } };
  }

  private tokenPage(url: URL, rows: readonly unknown[]): VendorAnswer {
    const token = url.searchParams.get('next_token');
    const offset =
      token === null ? 0 : /^cursor-\d+$/.test(token) ? Number(token.slice(7)) : Number.NaN;
    const requested = Number(url.searchParams.get('per_page') ?? 30);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > 100
    )
      return { status: 400, json: { code: 'invalid_value' } };
    const size = Math.min(requested, this.options.pageSize ?? requested);
    const next = new URL(url);
    next.searchParams.set('next_token', `cursor-${offset + size}`);
    return {
      status: 200,
      json: {
        data: rows.slice(offset, offset + size),
        paging: {
          next: offset + size < rows.length ? next.href : null,
          previous: null,
        },
      },
    };
  }
}
