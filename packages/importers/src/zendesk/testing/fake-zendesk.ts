import { z } from 'zod';
import { type VendorAnswer, VendorServer } from '../../testing/vendor-server.js';

const rowSchema = z.looseObject({ id: z.number().int().positive() });
const datedRowSchema = rowSchema.extend({ updated_at: z.iso.datetime() });
const fixtureSchema = z.strictObject({
  tickets: z.array(datedRowSchema).default([]),
  users: z.array(datedRowSchema).default([]),
  organizations: z.array(datedRowSchema).default([]),
  groups: z.array(rowSchema).default([]),
  ticket_fields: z.array(rowSchema).default([]),
  user_fields: z.array(rowSchema).default([]),
  organization_fields: z.array(rowSchema).default([]),
  custom_statuses: z.array(rowSchema).default([]),
  satisfaction_ratings: z.array(datedRowSchema).default([]),
  survey_responses: z.array(z.looseObject({ id: z.string().min(1) })).default([]),
  categories: z.array(rowSchema).default([]),
  sections: z.array(rowSchema).default([]),
  articles: z.array(datedRowSchema).default([]),
  user_segments: z.array(rowSchema).default([]),
  comments: z.record(z.string(), z.array(rowSchema)).default({}),
  audits: z.record(z.string(), z.array(rowSchema)).default({}),
  identities: z.record(z.string(), z.array(rowSchema)).default({}),
  translations: z.record(z.string(), z.array(rowSchema)).default({}),
  article_attachments: z.record(z.string(), z.array(rowSchema)).default({}),
});
export type ZendeskFixture = z.input<typeof fixtureSchema>;
type ZendeskRow = z.infer<typeof rowSchema>;
type DatedRow = z.infer<typeof datedRowSchema>;
type CursorState = { entity: string; since: number; offset: number };
type Media = { bytes: Buffer; expiresAt: number };

/** Documented Support/Guide contracts, checked 2026-10-14; synthetic data only. */
export class FakeZendesk {
  readonly server: VendorServer;
  private fixture: z.infer<typeof fixtureSchema>;
  private readonly cursors = new Map<string, CursorState>();
  private readonly media = new Map<string, Media>();
  private nextCursor = 1;
  private nextDownload = 1;

  constructor(
    fixture: ZendeskFixture,
    private readonly options: {
      authorization: string;
      now: number;
      pageSize?: number;
    },
  ) {
    this.fixture = fixtureSchema.parse(fixture);
    this.server = new VendorServer((url, authorization) => this.route(url, authorization));
  }

  replaceFixture(fixture: ZendeskFixture): void {
    this.fixture = fixtureSchema.parse(fixture);
  }

  advanceTime(seconds: number): void {
    this.options.now += z.number().int().positive().parse(seconds);
  }

  addAttachment(id: string, bytes: Buffer): string {
    this.media.set(id, { bytes: Buffer.from(bytes), expiresAt: Number.POSITIVE_INFINITY });
    return `${this.server.root}/attachments/token/${encodeURIComponent(id)}/file`;
  }

  expireDownloads(): void {
    for (const [id, media] of this.media) if (id.startsWith('download-')) media.expiresAt = 0;
  }

  private route(url: URL, authorization: string | undefined): VendorAnswer {
    if (url.pathname.startsWith('/cdn/')) return this.download(url, authorization);
    if (authorization !== this.options.authorization)
      return { status: 401, json: { error: 'Invalid credentials' } };
    if (url.pathname.startsWith('/attachments/token/')) return this.secureAttachment(url);
    if (url.pathname === '/api/v2/users/me.json')
      return { status: 200, json: { user: { id: 301, name: 'Migration admin', role: 'admin' } } };
    const userMatch = /^\/api\/v2\/users\/(\d+)\.json$/.exec(url.pathname);
    if (userMatch) {
      const user = this.fixture.users.find((candidate) => String(candidate.id) === userMatch[1]);
      return user ? { status: 200, json: { user } } : this.notFound();
    }
    const exportMatch = /^\/api\/v2\/incremental\/(tickets|users)\/cursor\.json$/.exec(
      url.pathname,
    );
    if (exportMatch) return this.cursorExport(url, exportMatch[1] ?? '');
    if (url.pathname === '/api/v2/incremental/organizations.json')
      return this.organizationExport(url);
    if (url.pathname === '/api/v2/guide/survey_responses') {
      const response = this.cursorCollectionPage(
        url,
        'survey_responses',
        this.fixture.survey_responses,
      );
      if (response.status !== 200) return response;
      const json = response.json as { meta: unknown; survey_responses: unknown };
      return { status: 200, json: { meta: json.meta, survey_responses: json.survey_responses } };
    }
    return this.collection(url);
  }

  private cursorExport(url: URL, entity: string): VendorAnswer {
    const token = url.searchParams.get('cursor');
    const state = token
      ? this.cursors.get(token)
      : {
          entity,
          since: Number(url.searchParams.get('start_time')),
          offset: 0,
        };
    if (
      !state ||
      state.entity !== entity ||
      !Number.isFinite(state.since) ||
      (!token && (!url.searchParams.has('start_time') || state.since > this.options.now - 60))
    )
      return { status: 400, json: { error: 'Invalid export cursor or start_time' } };
    if (entity === 'tickets' && url.searchParams.get('support_type_scope') !== 'all')
      return { status: 400, json: { error: 'Fixture requires explicit all-ticket scope' } };
    const source = entity === 'tickets' ? this.fixture.tickets : this.fixture.users;
    const rows = this.changed(source, state.since).filter(
      (row) =>
        entity !== 'tickets' ||
        url.searchParams.get('exclude_deleted') !== 'true' ||
        row.status !== 'deleted',
    );
    const size = this.pageSize(url);
    if (!size) return { status: 400, json: { error: 'Invalid per_page' } };
    const page = rows.slice(state.offset, state.offset + size);
    const end = state.offset + size >= rows.length;
    const after = `cursor-${this.nextCursor++}`;
    // The final cursor remains usable for delta, including an empty final page.
    const since = end ? this.options.now - 60 : state.since;
    this.cursors.set(after, { entity, since, offset: end ? 0 : state.offset + size });
    const afterUrl = new URL(url);
    afterUrl.searchParams.delete('start_time');
    afterUrl.searchParams.set('cursor', after);
    return {
      status: 200,
      json: {
        [entity]: page,
        after_cursor: after,
        after_url: afterUrl.href,
        before_cursor: null,
        before_url: null,
        end_of_stream: end,
      },
    };
  }

  private changed(rows: DatedRow[], since: number): DatedRow[] {
    return rows
      .filter((row) => {
        const timestamp =
          typeof row.generated_timestamp === 'number'
            ? row.generated_timestamp
            : Date.parse(row.updated_at) / 1000;
        return timestamp >= since && timestamp <= this.options.now - 60;
      })
      .sort(
        (first, second) =>
          Date.parse(first.updated_at) - Date.parse(second.updated_at) || first.id - second.id,
      );
  }

  private pageSize(url: URL, max = 1000): number {
    const size = Number(url.searchParams.get('per_page') ?? this.options.pageSize ?? max);
    return Number.isInteger(size) && size > 0 && size <= max ? size : 0;
  }

  private organizationExport(url: URL): VendorAnswer {
    const since = Number(url.searchParams.get('start_time'));
    if (!url.searchParams.has('start_time') || !Number.isFinite(since))
      return { status: 400, json: { error: 'Missing start_time' } };
    const rows = this.changed(this.fixture.organizations, since);
    const size = this.pageSize(url);
    if (!size) return { status: 400, json: { error: 'Invalid per_page' } };
    // Time exports may exceed their page target to retain every timestamp tie.
    const boundary = rows[Math.min(size, rows.length) - 1];
    const endTime = boundary ? Date.parse(boundary.updated_at) / 1000 + 1 : this.options.now - 60;
    const page = rows.filter((row) => Date.parse(row.updated_at) / 1000 < endTime);
    const end = page.length === rows.length;
    const next = new URL(url);
    next.searchParams.set('start_time', String(end ? this.options.now - 60 : endTime));
    return {
      status: 200,
      json: {
        organizations: page,
        count: page.length,
        end_time: end ? this.options.now - 60 : endTime,
        next_page: next.href,
        end_of_stream: end,
      },
    };
  }

  private collection(url: URL): VendorAnswer {
    const child =
      /^\/api\/v2\/(tickets|users|help_center\/articles)\/(\d+)\/(comments|audits|identities|translations|attachments)\.json$/.exec(
        url.pathname,
      );
    if (child) {
      const parent = child[1];
      const entity = child[3] === 'attachments' ? 'article_attachments' : child[3];
      const allowed =
        parent === 'tickets'
          ? ['comments', 'audits']
          : parent === 'users'
            ? ['identities']
            : ['translations', 'article_attachments'];
      if (!entity || !allowed.includes(entity)) return this.notFound();
      const children = {
        comments: this.fixture.comments,
        audits: this.fixture.audits,
        identities: this.fixture.identities,
        translations: this.fixture.translations,
        article_attachments: this.fixture.article_attachments,
      };
      const rows = children[entity as keyof typeof children][child[2] ?? ''];
      if (!rows) return this.notFound();
      return entity === 'comments'
        ? this.commentPage(url, rows)
        : this.offsetPage(url, entity, rows);
    }
    const entities = {
      '/api/v2/groups.json': ['groups', this.fixture.groups],
      '/api/v2/ticket_fields.json': ['ticket_fields', this.fixture.ticket_fields],
      '/api/v2/user_fields.json': ['user_fields', this.fixture.user_fields],
      '/api/v2/organization_fields.json': ['organization_fields', this.fixture.organization_fields],
      '/api/v2/custom_statuses.json': ['custom_statuses', this.fixture.custom_statuses],
      '/api/v2/satisfaction_ratings.json': [
        'satisfaction_ratings',
        this.fixture.satisfaction_ratings,
      ],
      '/api/v2/help_center/categories.json': ['categories', this.fixture.categories],
      '/api/v2/help_center/sections.json': ['sections', this.fixture.sections],
      '/api/v2/help_center/articles.json': ['articles', this.fixture.articles],
      '/api/v2/help_center/user_segments.json': ['user_segments', this.fixture.user_segments],
    } satisfies Record<string, readonly [string, ZendeskRow[]]>;
    const collection = entities[url.pathname as keyof typeof entities];
    if (!collection) return this.notFound();
    return url.searchParams.has('page[size]')
      ? this.cursorCollectionPage(url, collection[0], collection[1])
      : this.offsetPage(url, collection[0], collection[1]);
  }

  private offsetPage(url: URL, entity: string, rows: ZendeskRow[]): VendorAnswer {
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = this.pageSize(url, 100);
    if (!Number.isInteger(page) || page < 1 || !size)
      return { status: 400, json: { error: 'Invalid pagination' } };
    const offset = (page - 1) * size;
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    return {
      status: 200,
      json: {
        [entity]: rows.slice(offset, offset + size),
        count: rows.length,
        next_page: offset + size < rows.length ? next.href : null,
        previous_page: null,
      },
    };
  }

  private commentPage(url: URL, rows: ZendeskRow[]): VendorAnswer {
    return this.cursorCollectionPage(url, 'comments', rows);
  }

  private cursorCollectionPage(url: URL, entity: string, rows: readonly unknown[]): VendorAnswer {
    const size = Number(url.searchParams.get('page[size]') ?? this.options.pageSize ?? 100);
    const after = url.searchParams.get('page[after]');
    const cursor = after ? this.cursors.get(after) : undefined;
    const offset = after ? (cursor?.entity === url.pathname ? cursor.offset : undefined) : 0;
    if (!Number.isInteger(size) || size < 1 || size > 100 || offset === undefined)
      return { status: 400, json: { error: 'Invalid comment cursor' } };
    const hasMore = offset + size < rows.length;
    const token = `comments-${this.nextCursor++}`;
    this.cursors.set(token, { entity: url.pathname, since: 0, offset: offset + size });
    const next = new URL(url);
    next.searchParams.set('page[after]', token);
    return {
      status: 200,
      json: {
        [entity]: rows.slice(offset, offset + size),
        meta: { has_more: hasMore, after_cursor: token, before_cursor: null },
        links: { next: hasMore ? next.href : null, prev: null },
      },
    };
  }

  private secureAttachment(url: URL): VendorAnswer {
    const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
    const original = this.media.get(id);
    if (!original) return this.notFound();
    const downloadId = `download-${this.nextDownload++}`;
    this.media.set(downloadId, { bytes: original.bytes, expiresAt: Date.now() + 60000 });
    const download = new URL(`/cdn/${downloadId}`, this.server.root);
    download.hostname = 'cdn.zendesk.test';
    return { status: 302, headers: { location: download.href } };
  }

  private download(url: URL, authorization: string | undefined): VendorAnswer {
    if (authorization)
      return { status: 400, json: { error: 'CDN must not receive Support credentials' } };
    const media = this.media.get(url.pathname.slice('/cdn/'.length));
    return !media || media.expiresAt < Date.now()
      ? { status: 403, json: { error: 'Expired download' } }
      : { status: 200, bytes: media.bytes };
  }

  private notFound(): VendorAnswer {
    return { status: 404, json: { error: 'Record not found' } };
  }
}
